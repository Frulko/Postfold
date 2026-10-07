import type { MailAttachment } from '../../shared/authoring'

// Binary drafts belong in IndexedDB, not the small synchronous localStorage quota.
async function attachmentStore(key: string, action: 'read' | 'write' | 'delete', value?: MailAttachment[]): Promise<MailAttachment[]> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('postfold-draft-files', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('attachments')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction('attachments', action === 'read' ? 'readonly' : 'readwrite')
      const store = transaction.objectStore('attachments')
      const request = action === 'read' ? store.get(key) : action === 'delete' ? store.delete(key) : store.put(value, key)
      let result: MailAttachment[] = []
      request.onsuccess = () => { result = action === 'read' ? request.result ?? [] : value ?? [] }
      transaction.oncomplete = () => resolve(result)
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
  } finally { database.close() }
}
export const loadDraftFiles = (key: string) => attachmentStore(key, 'read')
export const saveDraftFiles = (key: string, files: MailAttachment[]) => attachmentStore(key, 'write', files)
export const deleteDraftFiles = (key: string) => attachmentStore(key, 'delete')
export async function fileAttachment(file: File): Promise<MailAttachment> {
  const content = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file) })
  return { filename: file.name, contentType: file.type || 'application/octet-stream', content }
}
export const attachmentBytes = (file: MailAttachment) => file.content.length / 4 * 3 - (file.content.endsWith('==') ? 2 : file.content.endsWith('=') ? 1 : 0)
