// IndexedDB persistence. Only raw samples are stored: where the line falls between noise
// and outage is an analysis decision made downstream.

const DB_NAME = 'wts';
const DB_VERSION = 1;
const ACTIVE_KEY = 'wts.active';

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  const mine = dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('sessions')) {
        db.createObjectStore('sessions', {keyPath: 'id'});
      }
      if (!db.objectStoreNames.contains('samples')) {
        const s = db.createObjectStore('samples', {keyPath: ['sessionId', 'seq']});
        s.createIndex('bySession', 'sessionId');
      }
      if (!db.objectStoreNames.contains('events')) {
        const e = db.createObjectStore('events', {keyPath: 'id', autoIncrement: true});
        e.createIndex('bySession', 'sessionId');
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // iOS closes the connection when the tab is backgrounded under storage pressure. A
      // cached promise for a closed connection makes every later write throw
      // InvalidStateError, so it is dropped and the next call opens again.
      db.onclose = () => { if (dbPromise === mine) dbPromise = null; };
      db.onversionchange = () => { db.close(); if (dbPromise === mine) dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => { if (dbPromise === mine) dbPromise = null; reject(req.error); };
    req.onblocked = () => { if (dbPromise === mine) dbPromise = null;
                            reject(new Error('database blocked by another tab')); };
  });
  return mine;
}

// A connection can also be found closed only on use, and that throw is synchronous. Every
// access goes through here so it is retried once against a fresh connection.
async function withDb(fn) {
  try {
    return await fn(await open());
  } catch (e) {
    if (e && e.name !== 'InvalidStateError') throw e;
    dbPromise = null;
    return fn(await open());
  }
}

function tx(db, stores, mode) {
  const t = db.transaction(stores, mode);
  return {
    t,
    done: new Promise((resolve, reject) => {
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('transaction aborted'));
    })
  };
}

function ask(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function ready() {
  await open();
  // Reduces the chance Safari's ITP evicts a session before it is exported.
  try { await navigator.storage?.persist?.(); } catch { /* unsupported */ }
}

export async function putSession(session) {
  await withDb(async db => {
    const {t, done} = tx(db, ['sessions'], 'readwrite');
    t.objectStore('sessions').put(session);
    await done;
  });
  return session;
}

export async function getSession(id) {
  return withDb(db => {
    const {t} = tx(db, ['sessions'], 'readonly');
    return ask(t.objectStore('sessions').get(id));
  });
}

export async function allSessions() {
  const list = await withDb(db => {
    const {t} = tx(db, ['sessions'], 'readonly');
    return ask(t.objectStore('sessions').getAll());
  });
  return list.sort((a, b) => b.started - a.started);
}

// One transaction for the whole batch, so a retried write cannot produce half-written
// rounds.
export async function putSamples(samples) {
  if (!samples.length) return;
  return withDb(async db => {
    const {t, done} = tx(db, ['samples'], 'readwrite');
    const store = t.objectStore('samples');
    for (const s of samples) store.put(s);
    await done;
  });
}

export async function putEvents(events) {
  if (!events.length) return;
  return withDb(async db => {
    const {t, done} = tx(db, ['events'], 'readwrite');
    const store = t.objectStore('events');
    for (const e of events) store.put(e);
    await done;
  });
}

// The index is keyed on sessionId and iterated in primary-key order, so samples come back
// ordered by seq.
export async function getSamples(sessionId) {
  return withDb(db => {
    const {t} = tx(db, ['samples'], 'readonly');
    return ask(t.objectStore('samples').index('bySession').getAll(sessionId));
  });
}

export async function getEvents(sessionId) {
  const list = await withDb(db => {
    const {t} = tx(db, ['events'], 'readonly');
    return ask(t.objectStore('events').index('bySession').getAll(sessionId));
  });
  return list.sort((a, b) => a.t - b.t);
}

export async function countSamples(sessionId) {
  return withDb(db => {
    const {t} = tx(db, ['samples'], 'readonly');
    return ask(t.objectStore('samples').index('bySession').count(sessionId));
  });
}

export async function deleteSession(id) {
  return withDb(async db => {
    const {t, done} = tx(db, ['sessions', 'samples', 'events'], 'readwrite');
    t.objectStore('sessions').delete(id);
    for (const name of ['samples', 'events']) {
      const cursor = t.objectStore(name).index('bySession').openKeyCursor(IDBKeyRange.only(id));
      cursor.onsuccess = () => {
        const c = cursor.result;
        if (!c) return;
        t.objectStore(name).delete(c.primaryKey);
        c.continue();
      };
    }
    await done;
  });
}

export async function estimate() {
  try {
    const e = await navigator.storage?.estimate?.();
    return e ? {usage: e.usage, quota: e.quota} : null;
  } catch { return null; }
}

// Persisted across a crash; on reload the page reads it and offers to resume.
export function setActive(id) {
  try { id ? localStorage.setItem(ACTIVE_KEY, id) : localStorage.removeItem(ACTIVE_KEY); }
  catch { /* private mode */ }
}

export function getActive() {
  try { return localStorage.getItem(ACTIVE_KEY); } catch { return null; }
}
