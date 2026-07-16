const storagePermissions = [
    {
        path: '/storage/overview',
        method: 'GET',
        permissions: ['storage.read']
    },
    {
        path: '/storage/last-backup-config',
        method: 'GET',
        permissions: ['storage.read']
    }
];

export { storagePermissions };