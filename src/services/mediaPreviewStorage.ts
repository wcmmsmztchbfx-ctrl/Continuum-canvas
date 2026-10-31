import { openDB } from 'idb'
const LIMIT = 128 * 1024 * 1024
async function database() {
  if (typeof indexedDB === 'undefined') return undefined
  try {
    return await openDB('continuum-disposable-media-previews', 2, {
      upgrade(db) {
        // Derived previews can be rebuilt; artwork never lives in this database.
        if (db.objectStoreNames.contains('previews')) db.deleteObjectStore('previews')
        db.createObjectStore('previews')
        db.createObjectStore('metadata', { keyPath: 'key' }).createIndex('touched', 'touched')
        db.createObjectStore('stats')
      },
    })
  } catch { return undefined }
}
export async function readMediaPreview(key: string): Promise<Blob | undefined> {
  const db = await database()
  if (!db) return undefined
  try {
    const tx = db.transaction(['previews', 'metadata'], 'readwrite')
    const blob = await tx.objectStore('previews').get(key) as Blob | undefined
    const metadata = await tx.objectStore('metadata').get(key)
    if (metadata) await tx.objectStore('metadata').put({ ...metadata, touched: Date.now() })
    await tx.done
    return blob
  } catch { return undefined } finally { db.close() }
}
export async function writeMediaPreview(key: string, blob: Blob): Promise<void> {
  if (blob.size > LIMIT) return
  const db = await database()
  if (!db) return
  try {
    const tx = db.transaction(['previews', 'metadata', 'stats'], 'readwrite')
    const previews = tx.objectStore('previews'), metadata = tx.objectStore('metadata'), stats = tx.objectStore('stats')
    const old = await metadata.get(key)
    let total = (await stats.get('bytes') ?? 0) - (old?.size ?? 0) + blob.size
    await previews.put(blob, key)
    await metadata.put({ key, size: blob.size, touched: Date.now(), format: 1 })
    // Only visit evicted metadata, never scan or deserialize every stored blob.
    let cursor = total > LIMIT ? await metadata.index('touched').openCursor() : null
    while (cursor && total > LIMIT) {
      total -= cursor.value.size
      await previews.delete(cursor.value.key); await cursor.delete()
      cursor = await cursor.continue()
    }
    await stats.put(total, 'bytes')
    await tx.done
  } catch { /* Disposable cache failures never affect original media. */ }
  finally { db.close() }
}
