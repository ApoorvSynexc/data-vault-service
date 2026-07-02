const restorePermissions = [
    {
        path: '/restore/get-backup-configs-name',
        method: 'GET',
        permissions: ['restore.read']
    },
    {
        path: '/restore/snapshot-logs',
        method: 'GET',
        permissions: ['restore.read']
    },
    {
        path: '/restore/retrieve/fetch-records',
        method: 'POST',
        permissions: ['restore.read']
    },
];

export { restorePermissions };