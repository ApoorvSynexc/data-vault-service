const restorePermissions = [
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