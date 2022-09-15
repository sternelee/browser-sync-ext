import { useStorageLocal } from '~/composables/useStorageLocal'

export const storageDemo = useStorageLocal('browser-sync', 'Browser Storage', { listenToStorageChanges: true })
