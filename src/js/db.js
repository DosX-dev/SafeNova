'use strict';

/* ============================================================
   DATABASE  —  IndexedDB abstraction
   ============================================================ */
const DB = (() => {
    let _db = null;

    async function init() {
        return new Promise((res, rej) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = e => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains('containers')) {
                    db.createObjectStore('containers', { keyPath: 'id' });
                }
                if (!db.objectStoreNames.contains('files')) {
                    const fs = db.createObjectStore('files', { keyPath: 'id' });
                    fs.createIndex('cid', 'cid');
                }
                if (!db.objectStoreNames.contains('vfs')) {
                    db.createObjectStore('vfs', { keyPath: 'cid' });
                }
            };
            req.onsuccess = e => {
                _db = e.target.result;
                _db.onversionchange = () => {
                    try { _db.close(); } catch { }
                    _db = null;
                };
                res();
            };
            req.onblocked = () => rej(new Error('Database upgrade blocked by another open tab'));
            req.onerror = () => rej(req.error);
        });
    }

    function _ensureDb() {
        if (!_db) throw new Error('Database is not initialized');
    }
    function rw(store) { _ensureDb(); return _db.transaction(store, 'readwrite').objectStore(store); }
    function ro(store) { _ensureDb(); return _db.transaction(store, 'readonly').objectStore(store); }
    function wrap(req) { return new Promise((r, j) => { req.onsuccess = () => r(req.result); req.onerror = () => j(req.error); }); }

    return {
        init,
        /* containers */
        getContainers: () => wrap(ro('containers').getAll()),
        saveContainer: (c) => wrap(rw('containers').put(c)),
        deleteContainer: (id) => wrap(rw('containers').delete(id)),

        /* files */
        saveFile: (f) => wrap(rw('files').put(f)),
        getFile: (id) => wrap(ro('files').get(id)),
        getFilesByCid: (cid) => wrap(ro('files').index('cid').getAll(cid)),
        deleteFile: (id) => wrap(rw('files').delete(id)),

        /* vfs */
        saveVFS: (cid, iv, blob) => wrap(rw('vfs').put({ cid, iv, blob })),
        getVFS: (cid) => wrap(ro('vfs').get(cid)),
        deleteVFS: (cid) => wrap(rw('vfs').delete(cid)),

        /* nuke container — deletes everything */
        async nukeContainer(cid) {
            const files = await this.getFilesByCid(cid);
            await Promise.all(files.map(f => this.deleteFile(f.id)));
            await this.deleteVFS(cid);
            await this.deleteContainer(cid);
        }
    };
})();
