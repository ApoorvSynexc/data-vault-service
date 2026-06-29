const restorePermissions = [
    {
        path: '/restore/snapshot-logs',
        method: 'GET',
        permissions: ['restore.read']
    },
];

export { restorePermissions };