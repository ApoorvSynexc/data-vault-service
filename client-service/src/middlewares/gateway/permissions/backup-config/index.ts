const backupConfigPermissions = [
    {
        path: '/backup-config/list',
        method: 'GET',
        permissions: ['backup.read']
    },
    {
        path: '/backup-config/stats',
        method: 'GET',
        permissions: ['backup.read']
    },
    {
        path: '/backup-config/objects',
        method: 'GET',
        permissions: ['backup.read']
    },
    {
        path: '/backup-config/objects-count',
        method: 'POST',
        permissions: ['backup.read']
    },
    {
        path: '/backup-config',
        method: 'GET',
        permissions: ['backup.read']
    },
    {
        path: '/backup-config',
        method: 'POST',
        permissions: ['backup.write']
    },
    {
        path: '/backup-config',
        method: 'PUT',
        permissions: ['backup.write']
    },
    {
        path: '/backup-config',
        method: 'DELETE',
        permissions: ['backup.delete']
    },
    {
        path: '/backup-config/fields',
        method: 'GET',
        permissions: ['backup.read']
    },
    {
        path: '/backup-config/initalize-payload-transform',
        method: 'GET',
        permissions: ['backup.read']
    },
    {
        path: '/backup-config/sync-metadata',
        method: 'GET',
        permissions: ['backup.read']
    }
];

export { backupConfigPermissions };