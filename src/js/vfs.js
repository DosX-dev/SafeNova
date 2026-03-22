'use strict';

/* ============================================================
   VFS  —  Virtual File System (in-memory, serialized encrypted)
   ============================================================ */
const VFS = (() => {
    let _nodes = {};  // id → Node
    let _pos = {};  // parentId → { nodeId: {x, y} }
    let _childIndex = {};  // parentId → Set<childId> — O(1) children lookup

    function _rebuildChildIndex() {
        _childIndex = {};
        for (const id of Object.keys(_nodes)) {
            if (id === 'root') continue;
            const pid = _nodes[id].parentId;
            if (pid != null) {
                if (!_childIndex[pid]) _childIndex[pid] = new Set();
                _childIndex[pid].add(id);
            }
        }
    }

    function init() {
        _nodes = { root: { id: 'root', type: 'folder', name: '/', parentId: null, ctime: Date.now(), mtime: Date.now() } };
        _pos = { root: {} };
        _childIndex = {};
    }

    function fromObj(obj) {
        _nodes = obj.nodes || {};
        _pos = obj.pos || {};
        if (!_nodes.root) _nodes.root = { id: 'root', type: 'folder', name: '/', parentId: null, ctime: Date.now(), mtime: Date.now() };
        if (!_pos.root) _pos.root = {};
        // Integrity repair pass 1: reattach orphaned nodes whose parentId points to non-existent node
        Object.values(_nodes).forEach(n => {
            if (n.id !== 'root' && n.parentId && !_nodes[n.parentId]) {
                console.warn('VFS: orphaned node', n.id, '— reattaching to root');
                n.parentId = 'root';
            }
        });
        // Integrity repair pass 2: detect and break real parent→child cycles
        // For each node walk the ancestor chain; if we revisit any node in the same chain → cycle
        Object.keys(_nodes).forEach(id => {
            if (id === 'root') return;
            const chain = new Set();
            let cur = id;
            while (cur && cur !== 'root') {
                if (chain.has(cur)) {
                    console.warn('VFS: cycle detected at node', cur, '— reattaching to root');
                    _nodes[cur].parentId = 'root';
                    break;
                }
                if (!_nodes[cur]) break;
                chain.add(cur);
                cur = _nodes[cur].parentId;
            }
        });
        // Integrity repair pass 3: prune _pos entries whose parent or child node no longer exists
        for (const pid of Object.keys(_pos)) {
            if (pid !== 'root' && !_nodes[pid]) { delete _pos[pid]; continue; }
            for (const nid of Object.keys(_pos[pid] || {})) {
                if (!_nodes[nid]) delete _pos[pid][nid];
            }
        }
        // Rebuild O(1) children index after loading + all repairs
        _rebuildChildIndex();
    }

    function toObj() { return { nodes: _nodes, pos: _pos }; }

    function children(pid) {
        const ids = _childIndex[pid];
        if (!ids || ids.size === 0) return [];
        const result = [];
        for (const id of ids) { if (_nodes[id]) result.push(_nodes[id]); }
        return result;
    }

    function getPos(pid, nid) { return (_pos[pid] || {})[nid] || null; }
    function setPos(pid, nid, x, y) {
        if (!_pos[pid]) _pos[pid] = {};
        // Always snap to the current grid so sub-pixel drift and legacy off-grid positions
        // are corrected at write time. Math.round handles both truncation and rounding.
        const sx = 8 + Math.max(0, Math.round((Math.round(x) - 8) / GRID_X)) * GRID_X;
        const sy = 8 + Math.max(0, Math.round((Math.round(y) - 8) / GRID_Y)) * GRID_Y;
        _pos[pid][nid] = { x: sx, y: sy };
    }
    function delPos(pid, nid) { if (_pos[pid]) delete _pos[pid][nid]; }

    function add(nd) {
        if (!nd?.id || nd.id === 'root' || !['file', 'folder'].includes(nd.type)) return;
        _nodes[nd.id] = nd;
        if (!_pos[nd.id] && nd.type === 'folder') _pos[nd.id] = {};
        // Maintain child index
        if (nd.parentId != null) {
            if (!_childIndex[nd.parentId]) _childIndex[nd.parentId] = new Set();
            _childIndex[nd.parentId].add(nd.id);
        }
    }

    function remove(id, _visited = new Set()) {
        if (_visited.has(id)) return;
        _visited.add(id);
        const n = _nodes[id]; if (!n) return;
        if (n.type === 'folder') {
            children(id).forEach(c => remove(c.id, _visited));
            delete _pos[id];
            delete _childIndex[id];
        }
        delPos(n.parentId, id);
        if (_childIndex[n.parentId]) _childIndex[n.parentId].delete(id);
        delete _nodes[id];
    }

    function rename(id, newName) {
        if (id !== 'root' && _nodes[id]) { _nodes[id].name = newName; _nodes[id].mtime = Date.now(); }
    }

    function move(id, newParentId) {
        const n = _nodes[id]; if (!n || !_nodes[newParentId]) return 'not_found';
        if (id === 'root' || _nodes[newParentId].type !== 'folder') return 'not_found';
        // prevent move into self or descendant — visited Set guards against corrupt-data infinite loops
        let c = newParentId;
        const _mv = new Set();
        while (c) {
            if (c === id) return 'cycle';
            if (_mv.has(c)) break;
            _mv.add(c);
            c = (_nodes[c] || {}).parentId;
        }
        // prevent duplicate name in destination
        if (children(newParentId).some(s => s.id !== id && s.name.toLowerCase() === n.name.toLowerCase())) return 'duplicate';
        const oldParentId = n.parentId;
        delPos(n.parentId, id);
        n.parentId = newParentId;
        n.mtime = Date.now();
        // Update child indexes
        if (_childIndex[oldParentId]) _childIndex[oldParentId].delete(id);
        if (!_childIndex[newParentId]) _childIndex[newParentId] = new Set();
        _childIndex[newParentId].add(id);
        return 'ok';
    }

    function totalSize() {
        let sum = 0;
        for (const id in _nodes) {
            const n = _nodes[id];
            if (n.type === 'file' && Number.isFinite(n.size)) sum += n.size;
        }
        return sum;
    }

    function breadcrumb(folderId) {
        const path = [], visited = new Set(); let cur = folderId;
        while (cur && !visited.has(cur)) {
            visited.add(cur);
            path.unshift(_nodes[cur]);
            cur = (_nodes[cur] || {}).parentId;
        }
        return path;
    }

    function fullPath(nodeId) {
        const parts = [], visited = new Set();
        let cur = nodeId;
        while (cur) {
            if (visited.has(cur)) break; // cycle guard
            visited.add(cur);
            const n = _nodes[cur];
            if (!n) break;
            if (n.id === 'root') break;
            parts.unshift(n.name);
            cur = n.parentId;
        }
        return '/~/' + (App.container ? App.container.name : '') + (parts.length ? '/' + parts.join('/') : '');
    }

    function autoPos(pid, idx, area) {
        const W = (area && area.clientWidth) || 800,
            cols = Math.max(1, Math.floor((W - 16) / GRID_X));
        // Build set of occupied grid cells
        const occupied = new Set();
        Object.values(_pos[pid] || {}).forEach(p => {
            const cx = Math.round((p.x - 8) / GRID_X);
            const cy = Math.round((p.y - 8) / GRID_Y);
            occupied.add(`${cx}_${cy}`);
        });
        // Row-by-row scan for first free cell
        for (let row = 0; row < 10000; row++) {
            for (let col = 0; col < cols; col++) {
                if (!occupied.has(`${col}_${row}`)) return { x: 8 + col * GRID_X, y: 8 + row * GRID_Y };
            }
        }
        const col = idx % cols, row = Math.floor(idx / cols);
        return { x: 8 + col * GRID_X, y: 8 + row * GRID_Y };
    }

    function node(id) { return _nodes[id]; }

    function hasChildNamed(pid, name) {
        const lower = name.toLowerCase();
        return children(pid).some(n => n.name.toLowerCase() === lower);
    }

    function wouldCycle(id, newParentId) {
        let c = newParentId;
        const _wc = new Set();
        while (c) {
            if (c === id) return true;
            if (_wc.has(c)) break;
            _wc.add(c);
            c = (_nodes[c] || {}).parentId;
        }
        return false;
    }

    function remapPositions(oldGX, oldGY, newGX, newGY) {
        if (oldGX === newGX && oldGY === newGY) return;
        for (const pid of Object.keys(_pos)) {
            const map = _pos[pid];
            for (const nid of Object.keys(map)) {
                const p = map[nid];
                const cx = Math.round((p.x - 8) / oldGX);
                const cy = Math.round((p.y - 8) / oldGY);
                map[nid] = { x: 8 + cx * newGX, y: 8 + cy * newGY };
            }
        }
    }

    // ── Integrity checker ──────────────────────────────────────
    // Returns array of step results: [{ name, status:'pass'|'warn'|'fail', detail, issues[], fixed[] }]
    // When repair=true, fixes issues in-place. Synchronous (VFS structure only).
    function check(repair) {
        const steps = [];

        function step(name, fn, informational = false) {
            const issues = [], fixed = [];
            const log = (sev, msg) => issues.push({ sev, msg });
            const fix = (msg) => fixed.push(msg);
            fn(log, fix);
            const hasCrit = issues.some(i => i.sev === 'critical');
            const status = issues.length === 0 ? 'pass' : hasCrit ? 'fail' : 'warn';
            const detail = issues.length === 0 ? 'OK' : `${issues.length} issue${issues.length !== 1 ? 's' : ''}${repair && fixed.length ? `, ${fixed.length} fixed` : ''}`;
            steps.push({ name, status, detail, issues, fixed, informational });
        }

        // 1. Root node & position map
        step('Root node integrity', (log, fix) => {
            if (!_nodes.root) {
                log('critical', 'Root node missing');
                if (repair) { _nodes.root = { id: 'root', type: 'folder', name: '/', parentId: null, ctime: Date.now(), mtime: Date.now() }; fix('Recreated root node'); }
            } else {
                if (_nodes.root.parentId !== null) {
                    log('warn', 'Root has non-null parentId');
                    if (repair) { _nodes.root.parentId = null; fix('Set root parentId to null'); }
                }
                if (_nodes.root.type !== 'folder') {
                    log('critical', 'Root node type is not folder');
                    if (repair) { _nodes.root.type = 'folder'; fix('Fixed root type to folder'); }
                }
            }
            if (!_pos.root) {
                log('warn', 'Root position map missing');
                if (repair) { _pos.root = {}; fix('Recreated root position map'); }
            }
        });

        const allIds = Object.keys(_nodes);

        // 2. Node required fields
        step('Node field validation', (log, fix) => {
            const _now = Date.now();
            for (const id of allIds) {
                const n = _nodes[id];
                if (!n.id || n.id !== id) {
                    log('critical', `Node "${id}": id mismatch or missing`);
                    if (repair) { n.id = id; fix(`Fixed id for "${id}"`); }
                }
                if (id !== 'root' && !n.name) {
                    log('warn', `Node "${id}": name missing`);
                    if (repair) { n.name = 'Recovered_' + id.slice(0, 6); fix(`Set fallback name for "${id}"`); }
                }
                if (!n.type || !['file', 'folder'].includes(n.type)) {
                    log('warn', `Node "${id}": invalid type "${n.type}"`);
                    if (repair) { n.type = 'file'; fix(`Set type to file for "${id}"`); }
                }
                if (id !== 'root') {
                    const badCtime = !n.ctime || typeof n.ctime !== 'number' || n.ctime <= 0 || !isFinite(n.ctime);
                    const badMtime = !n.mtime || typeof n.mtime !== 'number' || n.mtime <= 0 || !isFinite(n.mtime);
                    if (badCtime) {
                        log('warn', `"${n.name || id}": missing or invalid ctime`);
                        if (repair) { n.ctime = _now; fix(`Restored ctime for "${n.name || id}"`); }
                    }
                    if (badMtime) {
                        log('warn', `"${n.name || id}": missing or invalid mtime`);
                        if (repair) { n.mtime = n.ctime || _now; fix(`Restored mtime for "${n.name || id}"`); }
                    }
                }
            }
        });

        // 3. Node ID format validation
        step('Node ID format validation', (log, fix) => {
            const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
            const fallbackRe = /^[0-9a-z]{6,20}$/i;
            let badCount = 0;
            for (const id of allIds) {
                if (id === 'root') continue;
                if (!uuidRe.test(id) && !fallbackRe.test(id)) {
                    badCount++;
                    log('warn', `"${id.slice(0, 24)}${id.length > 24 ? '…' : ''}": malformed node ID`);
                    if (repair) {
                        const n = _nodes[id], newId = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
                        n.id = newId;
                        _nodes[newId] = n;
                        delete _nodes[id];
                        // Update children referencing old ID as parent
                        for (const cid of Object.keys(_nodes)) {
                            if (_nodes[cid].parentId === id) _nodes[cid].parentId = newId;
                        }
                        // Migrate position data
                        if (_pos[id]) { _pos[newId] = _pos[id]; delete _pos[id]; }
                        for (const pid of Object.keys(_pos)) {
                            if (_pos[pid][id]) { _pos[pid][newId] = _pos[pid][id]; delete _pos[pid][id]; }
                        }
                        fix(`Reassigned ID for "${n.name || newId}"`);
                    }
                }
            }
        });

        // 4. Timestamp anomaly detection — when >50% of nodes share an identical ctime,
        //    it indicates a bulk-import or corruption event. On repair, spread those ctimes
        //    across a 1-second window so each node gets a unique, meaningful timestamp.
        step('Timestamp anomaly detection', (log, fix) => {
            if (allIds.length < 20) return;
            const ctimeMap = new Map();
            for (const id of allIds) {
                if (id === 'root') continue;
                const ct = _nodes[id].ctime;
                if (ct) ctimeMap.set(ct, (ctimeMap.get(ct) || 0) + 1);
            }
            let maxCluster = 0, maxTime = 0;
            for (const [t, count] of ctimeMap) {
                if (count > maxCluster) { maxCluster = count; maxTime = t; }
            }
            const total = allIds.length - 1;
            if (maxCluster > total * 0.5 && maxCluster > 50) {
                log('warn', `${maxCluster} of ${total} nodes share identical ctime (${new Date(maxTime).toISOString()}) — possible bulk-import or VFS corruption`);
                if (repair) {
                    // Spread affected nodes across 1-second window (1 ms apart) so each gets unique ctime
                    const base = Date.now();
                    let offset = 0;
                    for (const id of allIds) {
                        if (id === 'root') continue;
                        if (_nodes[id].ctime === maxTime) {
                            _nodes[id].ctime = base + offset;
                            if (!_nodes[id].mtime || _nodes[id].mtime === maxTime) _nodes[id].mtime = base + offset;
                            offset++;
                        }
                    }
                    fix(`Spread ${maxCluster} identical ctimes across a 1-second window`);
                }
            }
        });

        // 5. File name validation
        step('File name validation', (log, fix) => {
            for (const id of allIds) {
                if (id === 'root') continue;
                const n = _nodes[id];
                if (typeof n.name === 'string') {
                    if (n.name.trim() === '') {
                        log('warn', `Node "${id}": name is empty/whitespace`);
                        if (repair) { n.name = 'Unnamed_' + id.slice(0, 6); fix(`Set fallback name for "${id}"`); }
                    } else if (n.name.length > 255) {
                        log('warn', `"${n.name.slice(0, 30)}...": name exceeds 255 chars`);
                        if (repair) { n.name = n.name.slice(0, 200) + '…'; fix(`Truncated name of "${id}"`); }
                    } else if (/[<>:"/\\|?*\x00-\x1f]/.test(n.name)) {
                        log('warn', `"${n.name}": contains invalid characters`);
                        if (repair) { n.name = n.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_'); fix(`Sanitized name of "${id}"`); }
                    }
                }
            }
        });

        // 6. Orphaned nodes (parentId → non-existent node)
        step('Orphaned node detection', (log, fix) => {
            for (const id of allIds) {
                if (id === 'root') continue;
                const n = _nodes[id];
                if (n.parentId && !_nodes[n.parentId]) {
                    log('critical', `"${n.name || id}": parent "${n.parentId}" does not exist`);
                    if (repair) { n.parentId = 'root'; fix(`Reattached "${n.name || id}" to root`); }
                }
                if (!n.parentId) {
                    log('warn', `"${n.name || id}": missing parentId`);
                    if (repair) { n.parentId = 'root'; fix(`Assigned parentId=root for "${n.name || id}"`); }
                }
            }
        });

        // 7. Parent type validation — parent must be a folder
        step('Parent type validation', (log, fix) => {
            for (const id of allIds) {
                if (id === 'root') continue;
                const n = _nodes[id];
                const parent = _nodes[n.parentId];
                if (parent && parent.type !== 'folder') {
                    log('critical', `"${n.name || id}": parent "${parent.name || n.parentId}" is not a folder`);
                    if (repair) { n.parentId = 'root'; fix(`Reattached "${n.name || id}" to root (parent was a file)`); }
                }
            }
        });

        // 8. Cycle detection + 9. Reachability (combined O(n) with memoization)
        //    Each node is visited at most twice (once for cycle check, once for reachability cache)
        step('Parent-child cycle detection', (log, fix) => {
            // Phase A: detect and break cycles
            const visiting = new Set(), safe = new Set(['root']);
            for (const id of allIds) {
                if (id === 'root' || safe.has(id)) continue;
                const path = [];
                let cur = id;
                while (cur && cur !== 'root' && !safe.has(cur)) {
                    if (visiting.has(cur)) {
                        // Cycle found — break at this node
                        log('critical', `Cycle at "${_nodes[cur]?.name || cur}"`);
                        if (repair) { _nodes[cur].parentId = 'root'; fix(`Broke cycle: reattached "${_nodes[cur]?.name || cur}" to root`); }
                        break;
                    }
                    visiting.add(cur);
                    path.push(cur);
                    if (!_nodes[cur]) break;
                    cur = _nodes[cur].parentId;
                }
                // Mark entire path as safe (regardless of how the chain ended)
                for (const p of path) { safe.add(p); visiting.delete(p); }
            }
        });

        step('Node reachability analysis', (log, fix) => {
            // Phase B: check reachability with cache (O(n) amortized)
            const reachCache = new Map(); // id → boolean
            reachCache.set('root', true);
            function isReachable(nid) {
                if (reachCache.has(nid)) return reachCache.get(nid);
                const chain = [];
                let cur = nid;
                while (cur && !reachCache.has(cur)) {
                    chain.push(cur);
                    cur = _nodes[cur]?.parentId;
                }
                const result = cur ? (reachCache.get(cur) || false) : false;
                for (const c of chain) reachCache.set(c, result);
                return result;
            }
            for (const id of allIds) {
                if (id === 'root') continue;
                if (!isReachable(id)) {
                    log('warn', `"${_nodes[id]?.name || id}" is unreachable from root`);
                    if (repair) {
                        _nodes[id].parentId = 'root';
                        reachCache.set(id, true);
                        fix(`Reattached unreachable "${_nodes[id]?.name || id}" to root`);
                    }
                }
            }
        });

        // 10. Timestamp validation
        step('Timestamp integrity', (log, fix) => {
            const now = Date.now(), futureThreshold = now + 86400000;
            for (const id of allIds) {
                const n = _nodes[id];
                if (!n.ctime || typeof n.ctime !== 'number' || n.ctime <= 0) {
                    log('warn', `"${n.name || id}": invalid ctime`);
                    if (repair) { n.ctime = now; fix(`Fixed ctime for "${n.name || id}"`); }
                } else if (n.ctime > futureThreshold) {
                    log('warn', `"${n.name || id}": ctime is in the future`);
                    if (repair) { n.ctime = now; fix(`Reset future ctime for "${n.name || id}"`); }
                }
                if (!n.mtime || typeof n.mtime !== 'number' || n.mtime <= 0) {
                    log('warn', `"${n.name || id}": invalid mtime`);
                    if (repair) { n.mtime = now; fix(`Fixed mtime for "${n.name || id}"`); }
                } else if (n.mtime > futureThreshold) {
                    log('warn', `"${n.name || id}": mtime is in the future`);
                    if (repair) { n.mtime = now; fix(`Reset future mtime for "${n.name || id}"`); }
                }
                if (n.mtime && n.ctime && n.mtime < n.ctime) {
                    log('warn', `"${n.name || id}": mtime is earlier than ctime`);
                    if (repair) { n.mtime = n.ctime; fix(`Corrected mtime for "${n.name || id}"`); }
                }
            }
        });

        // 11. File size & folder size validation
        step('File size validation', (log, fix) => {
            for (const id of allIds) {
                const n = _nodes[id];
                if (n.type === 'file') {
                    if (n.size !== undefined && (!Number.isFinite(n.size) || n.size < 0)) {
                        log('warn', `"${n.name || id}": invalid size ${n.size}`);
                        if (repair) { n.size = 0; fix(`Reset size for "${n.name || id}"`); }
                    }
                    if (n.size === undefined) {
                        log('warn', `"${n.name || id}": missing size property`);
                        if (repair) { n.size = 0; fix(`Set size=0 for "${n.name || id}"`); }
                    }
                }
                if (n.type === 'folder' && n.size !== undefined) {
                    log('warn', `Folder "${n.name || id}": has size property`);
                    if (repair) { delete n.size; fix(`Removed size from folder "${n.name || id}"`); }
                }
            }
        });

        // 12. File MIME type check
        step('File metadata validation', (log, fix) => {
            const allowed = new Set(['id', 'name', 'type', 'parentId', 'ctime', 'mtime', 'size', 'mime', 'color']);
            for (const id of allIds) {
                const n = _nodes[id];
                if (n.type === 'file') {
                    if (n.mime !== undefined && typeof n.mime !== 'string') {
                        log('warn', `"${n.name || id}": invalid mime type`);
                        if (repair) { delete n.mime; fix(`Removed invalid mime for "${n.name || id}"`); }
                    }
                }
                for (const key of Object.keys(n)) {
                    if (!allowed.has(key)) {
                        log('warn', `"${n.name || id}": unexpected property "${key}"`);
                        if (repair) { delete n[key]; fix(`Removed unknown property "${key}" from "${n.name || id}"`); }
                    }
                }
            }
        });

        // 13. Duplicate names in same parent
        step('Duplicate name detection', (log, fix) => {
            const parentChildren = {};
            for (const id of allIds) {
                if (id === 'root') continue;
                const pid = _nodes[id].parentId;
                if (!parentChildren[pid]) parentChildren[pid] = [];
                parentChildren[pid].push(_nodes[id]);
            }
            for (const pid of Object.keys(parentChildren)) {
                const seen = new Map();
                for (const n of parentChildren[pid]) {
                    const lower = n.name?.toLowerCase();
                    if (seen.has(lower)) {
                        log('warn', `Duplicate "${n.name}" in "${_nodes[pid]?.name || pid}"`);
                        if (repair) {
                            let counter = 2, base = n.name, ext = '';
                            const dotIdx = base.lastIndexOf('.');
                            if (n.type === 'file' && dotIdx > 0) { ext = base.slice(dotIdx); base = base.slice(0, dotIdx); }
                            while (parentChildren[pid].some(s => s.name.toLowerCase() === (base + ' (' + counter + ')' + ext).toLowerCase())) counter++;
                            n.name = base + ' (' + counter + ')' + ext;
                            fix(`Renamed duplicate to "${n.name}"`);
                        }
                    } else {
                        seen.set(lower, n);
                    }
                }
            }
        });

        // 14. Empty folder chains (folder containing only empty folders, depth > 5, read-only)
        step('Empty folder chain detection', (log) => {
            const childCount = {}, folderKids = new Map();
            for (const id of allIds) {
                if (id === 'root') continue;
                const pid = _nodes[id].parentId;
                if (!childCount[pid]) childCount[pid] = { files: 0, folders: 0 };
                if (_nodes[id].type === 'file') childCount[pid].files++;
                else {
                    childCount[pid].folders++;
                    if (!folderKids.has(pid)) folderKids.set(pid, []);
                    folderKids.get(pid).push(id);
                }
            }
            // Iterative post-order DFS — no recursion to avoid stack overflow on deep chains
            const emptyCache = new Map();
            for (const startId of allIds) {
                if (_nodes[startId]?.type !== 'folder' || startId === 'root') continue;
                if (emptyCache.has(startId)) continue;
                const stack = [{ id: startId, childIdx: 0 }];
                while (stack.length) {
                    const top = stack[stack.length - 1];
                    const kids = folderKids.get(top.id) || [];
                    let pushed = false;
                    while (top.childIdx < kids.length) {
                        const kid = kids[top.childIdx++];
                        if (!emptyCache.has(kid) && _nodes[kid]?.type === 'folder') {
                            stack.push({ id: kid, childIdx: 0 });
                            pushed = true;
                            break;
                        }
                    }
                    if (!pushed) {
                        stack.pop();
                        const cc = childCount[top.id];
                        if (!cc || (cc.files === 0 && cc.folders === 0)) {
                            emptyCache.set(top.id, 1);
                        } else if (cc.files > 0) {
                            emptyCache.set(top.id, 0);
                        } else {
                            let maxD = 0;
                            for (const sub of (folderKids.get(top.id) || [])) maxD = Math.max(maxD, emptyCache.get(sub) || 0);
                            emptyCache.set(top.id, maxD > 0 ? maxD + 1 : 0);
                        }
                    }
                }
            }
            for (const id of allIds) {
                if (_nodes[id]?.type !== 'folder' || id === 'root') continue;
                const d = emptyCache.get(id) || 0;
                if (d > 5) log('warn', `"${_nodes[id].name}": empty folder chain ${d} levels deep`);
            }
        }, true);

        // 15. Stale position entries
        step('Position table cleanup', (log, fix) => {
            for (const pid of Object.keys(_pos)) {
                if (pid !== 'root' && !_nodes[pid]) {
                    log('warn', `Position map for deleted folder "${pid}"`);
                    if (repair) { delete _pos[pid]; fix(`Removed stale position map "${pid}"`); }
                    continue;
                }
                for (const nid of Object.keys(_pos[pid] || {})) {
                    if (!_nodes[nid]) {
                        log('warn', `Position for deleted node "${nid}"`);
                        if (repair) { delete _pos[pid][nid]; fix(`Removed stale position "${nid}"`); }
                    } else if (_nodes[nid].parentId !== pid) {
                        log('warn', `"${_nodes[nid]?.name || nid}" positioned in wrong folder`);
                        if (repair) { delete _pos[pid][nid]; fix(`Removed misplaced position for "${_nodes[nid]?.name || nid}"`); }
                    }
                }
            }
        });

        // 16. Missing position maps for folders
        step('Folder position maps', (log, fix) => {
            for (const id of allIds) {
                if (_nodes[id].type === 'folder' && !_pos[id]) {
                    log('warn', `Folder "${_nodes[id].name || id}" has no position map`);
                    if (repair) { _pos[id] = {}; fix(`Created position map for "${_nodes[id].name || id}"`); }
                }
            }
        });

        // 17. Position completeness — only flag if the parent folder has been visited
        // Positions are lazily assigned when a folder is first opened.
        // Files in never-opened folders naturally have no position yet — not an error.
        step('Position entry completeness', (log, fix) => {
            for (const id of allIds) {
                if (id === 'root') continue;
                const pid = _nodes[id].parentId;
                if (!pid || !_pos[pid]) continue;
                const posMap = _pos[pid];
                // If no siblings have positions, the folder was never opened — skip
                if (Object.keys(posMap).length === 0) continue;
                if (!posMap[id]) {
                    log('warn', `"${_nodes[id]?.name || id}" has no position in parent folder`);
                    if (repair) {
                        const ap = autoPos(pid, 0, null);
                        _pos[pid][id] = { x: ap.x, y: ap.y };
                        fix(`Auto-positioned "${_nodes[id]?.name || id}"`);
                    }
                }
            }
        });

        // 18. Position collisions
        step('Position collision detection', (log, fix) => {
            for (const pid of Object.keys(_pos)) {
                const cellMap = new Map();
                for (const nid of Object.keys(_pos[pid] || {})) {
                    const p = _pos[pid][nid];
                    const key = `${Math.round((p.x - 8) / GRID_X)}_${Math.round((p.y - 8) / GRID_Y)}`;
                    if (cellMap.has(key)) {
                        log('warn', `Collision: "${_nodes[nid]?.name || nid}" and "${_nodes[cellMap.get(key)]?.name || cellMap.get(key)}"`);
                        if (repair) {
                            const newP = autoPos(pid, 0, null);
                            _pos[pid][nid] = { x: newP.x, y: newP.y };
                            fix(`Relocated "${_nodes[nid]?.name || nid}"`);
                        }
                    } else {
                        cellMap.set(key, nid);
                    }
                }
            }
        });

        // 19. Grid alignment
        step('Grid alignment verification', (log, fix) => {
            for (const pid of Object.keys(_pos)) {
                for (const nid of Object.keys(_pos[pid] || {})) {
                    const p = _pos[pid][nid];
                    const sx = 8 + Math.max(0, Math.round((p.x - 8) / GRID_X)) * GRID_X;
                    const sy = 8 + Math.max(0, Math.round((p.y - 8) / GRID_Y)) * GRID_Y;
                    if (p.x !== sx || p.y !== sy) {
                        log('warn', `"${_nodes[nid]?.name || nid}" is off-grid (${p.x},${p.y})`);
                        if (repair) { _pos[pid][nid] = { x: sx, y: sy }; fix(`Snapped "${_nodes[nid]?.name || nid}" to grid`); }
                    }
                }
            }
        });

        // 20. Folder depth check (O(n) memoized)
        step('Folder depth analysis', (log) => {
            const dc = new Map([[undefined, 0], [null, 0], ['root', 0]]);
            function depth(nid) {
                if (dc.has(nid)) return dc.get(nid);
                const chain = [];
                let cur = nid;
                while (cur && !dc.has(cur)) { chain.push(cur); cur = _nodes[cur]?.parentId; }
                let d = dc.get(cur) || 0;
                for (let i = chain.length - 1; i >= 0; i--) dc.set(chain[i], ++d);
                return dc.get(nid) || 0;
            }
            for (const id of allIds) {
                if (_nodes[id]?.type !== 'folder' || id === 'root') continue;
                const d = depth(id);
                if (d > 50) log('warn', `"${_nodes[id]?.name || id}" is nested ${d} levels deep`);
            }
        });

        // 21. Node count & summary stats
        step('Node count summary', (log) => {
            const files = allIds.filter(id => _nodes[id]?.type === 'file').length;
            const folders = allIds.filter(id => _nodes[id]?.type === 'folder').length - 1;
            const posEntries = Object.values(_pos).reduce((s, m) => s + Object.keys(m).length, 0);
            log('info', `${files} file${files !== 1 ? 's' : ''}, ${folders} folder${folders !== 1 ? 's' : ''}, ${posEntries} position entries`);
        });

        // Override: last step is always info-only (pass)
        const last = steps[steps.length - 1];
        last.status = 'pass';
        last.detail = last.issues[0]?.msg || 'OK';

        // After repair passes that mutate _nodes directly, rebuild child index
        if (repair) _rebuildChildIndex();

        return steps;
    }

    // Returns list of file IDs that exist in VFS as type 'file'
    function fileIds() {
        return Object.keys(_nodes).filter(id => _nodes[id]?.type === 'file');
    }

    // Bulk-purge every node that is NOT an ancestor of any live file.
    // O(n) — single pass: mark ancestors, then delete everything else.
    // Returns count of removed nodes.
    function purgeDeadBranches(liveFileIds) {
        const keep = new Set(['root']);
        for (const id of liveFileIds) {
            let cur = id;
            while (cur && !keep.has(cur)) {
                keep.add(cur);
                cur = _nodes[cur]?.parentId;
            }
        }
        // Delete all nodes not in keep — single pass, no child scans
        let removed = 0;
        for (const id of Object.keys(_nodes)) {
            if (!keep.has(id)) {
                delete _nodes[id];
                removed++;
            }
        }
        // Rebuild _pos: drop maps for gone folders, drop entries for gone nodes
        for (const pid of Object.keys(_pos)) {
            if (!keep.has(pid)) { delete _pos[pid]; continue; }
            for (const nid of Object.keys(_pos[pid] || {})) {
                if (!keep.has(nid)) delete _pos[pid][nid];
            }
        }
        _rebuildChildIndex();
        return removed;
    }

    // Flatten tree: move all files deeper than MAX_DEPTH up to their nearest ≤MAX_DEPTH ancestor,
    // then delete any (now-empty) folders still at depth > MAX_DEPTH.
    // Preserves ALL file data. Returns count of removed folders.
    function flattenDeepContent(MAX_DEPTH = 50) {
        const allIds = Object.keys(_nodes);

        // 1. O(n) memoized depth computation
        const dc = new Map([[undefined, 0], [null, 0], ['root', 0]]);
        function depth(nid) {
            if (dc.has(nid)) return dc.get(nid);
            const chain = [];
            let cur = nid;
            while (cur && !dc.has(cur)) { chain.push(cur); cur = _nodes[cur]?.parentId; }
            let d = dc.get(cur) || 0;
            for (let i = chain.length - 1; i >= 0; i--) dc.set(chain[i], ++d);
            return dc.get(nid) || 0;
        }
        for (const id of allIds) depth(id);

        // 2. Pre-build name sets per folder for collision detection
        const namesByParent = new Map();
        function getNames(pid) {
            if (!namesByParent.has(pid)) {
                const s = new Set(
                    Object.keys(_nodes)
                        .filter(id => _nodes[id]?.parentId === pid)
                        .map(id => _nodes[id].name.toLowerCase())
                );
                namesByParent.set(pid, s);
            }
            return namesByParent.get(pid);
        }
        function uniqueName(pid, name) {
            const names = getNames(pid);
            if (!names.has(name.toLowerCase())) { names.add(name.toLowerCase()); return name; }
            const dot = name.lastIndexOf('.');
            const base = dot >= 0 ? name.slice(0, dot) : name;
            const ext = dot >= 0 ? name.slice(dot) : '';
            let i = 1;
            while (names.has(`${base} (${i})${ext}`.toLowerCase())) i++;
            const result = `${base} (${i})${ext}`;
            names.add(result.toLowerCase());
            return result;
        }

        // 3. Reparent all files whose parent folder is deeper than MAX_DEPTH
        for (const id of allIds) {
            const n = _nodes[id];
            if (!n || n.type !== 'file') continue;
            if (depth(n.parentId) <= MAX_DEPTH) continue;

            // Walk up to the closest ancestor at depth ≤ MAX_DEPTH
            let targetPid = n.parentId;
            while (targetPid && depth(targetPid) > MAX_DEPTH) targetPid = _nodes[targetPid]?.parentId;
            if (!targetPid) targetPid = 'root';

            const oldPid = n.parentId;
            n.name = uniqueName(targetPid, n.name);
            n.parentId = targetPid;
            n.mtime = Date.now();

            // Update position maps
            if (_pos[oldPid]) delete _pos[oldPid][id];
            if (!_pos[targetPid]) _pos[targetPid] = {};
            const posIdx = Object.keys(_pos[targetPid]).length;
            const cols = Math.max(1, Math.floor((800 - 16) / GRID_X));
            _pos[targetPid][id] = { x: 8 + (posIdx % cols) * GRID_X, y: 8 + Math.floor(posIdx / cols) * GRID_Y };
        }

        // 4. Delete all folders now at depth > MAX_DEPTH (no files remain in them)
        let removed = 0;
        for (const id of Object.keys(_nodes)) {
            const n = _nodes[id];
            if (!n || n.type !== 'folder' || id === 'root') continue;
            if (depth(id) > MAX_DEPTH) {
                delete _nodes[id];
                delete _pos[id];
                removed++;
            }
        }

        // 5. Clean stale _pos entries
        for (const pid of Object.keys(_pos)) {
            if (!_nodes[pid] && pid !== 'root') { delete _pos[pid]; continue; }
            for (const nid of Object.keys(_pos[pid] || {})) {
                if (!_nodes[nid]) delete _pos[pid][nid];
            }
        }

        _rebuildChildIndex();
        return removed;
    }

    // Fix all corrupted/missing timestamps on every node. O(n), no side-effects beyond timestamps.
    // Returns count of nodes whose metadata was patched.
    function repairMetadata() {
        const now = Date.now();
        let fixed = 0;
        for (const id of Object.keys(_nodes)) {
            if (id === 'root') continue;
            const n = _nodes[id];
            let changed = false;
            if (!n.ctime || typeof n.ctime !== 'number' || n.ctime <= 0 || !isFinite(n.ctime)) {
                n.ctime = now; changed = true;
            }
            if (!n.mtime || typeof n.mtime !== 'number' || n.mtime <= 0 || !isFinite(n.mtime)) {
                n.mtime = n.ctime; changed = true;
            }
            if (changed) fixed++;
        }
        return fixed;
    }

    // Batch auto-positioning: builds the occupied set ONCE and assigns positions to all items
    // that need one. Stores positions in _pos[pid] and returns Map<nodeId, {x, y}>.
    function autoPosBatch(pid, items, area) {
        if (!items.length) return new Map();
        if (!_pos[pid]) _pos[pid] = {};
        const W = (area && area.clientWidth) || 800,
            cols = Math.max(1, Math.floor((W - 16) / GRID_X));
        // Build occupied set once from existing positions
        const occupied = new Set();
        for (const p of Object.values(_pos[pid])) {
            occupied.add(`${Math.round((p.x - 8) / GRID_X)}_${Math.round((p.y - 8) / GRID_Y)}`);
        }
        const results = new Map();
        let scanRow = 0, scanCol = 0;
        outer: for (const n of items) {
            for (let row = scanRow; row < 10000; row++) {
                for (let col = (row === scanRow ? scanCol : 0); col < cols; col++) {
                    if (!occupied.has(`${col}_${row}`)) {
                        const pos = { x: 8 + col * GRID_X, y: 8 + row * GRID_Y };
                        _pos[pid][n.id] = pos;
                        occupied.add(`${col}_${row}`);
                        results.set(n.id, pos);
                        scanRow = row; scanCol = col + 1;
                        if (scanCol >= cols) { scanCol = 0; scanRow = row + 1; }
                        continue outer;
                    }
                }
            }
        }
        return results;
    }

    return {
        init, fromObj, toObj, children, node, add, remove, rename, move, wouldCycle,
        getPos, setPos, delPos, totalSize, breadcrumb, fullPath, autoPos, autoPosBatch,
        hasChildNamed, remapPositions, check, fileIds, purgeDeadBranches,
        flattenDeepContent, repairMetadata
    };
})();
