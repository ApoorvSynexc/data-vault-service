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
    {
        path : '/restore/get-objectlist-by-configid',
        method: 'GET',
        permissions: ['restore.read']
    },
    {
        path : '/restore/fetch-object-fields',
        method: 'GET',
        permissions: ['restore.read']
    },
    {
        path : '/restore/fetch-change-between-backup-jobs',
        method: 'GET',
        permissions: ['restore.read']
    },
    {
        path : '/restore/get-picklist-field-values',
        method: 'GET',
        permissions: ['restore.read']
    },
    {
        path : '/restore',
        method: 'POST',
        permissions: ['restore.write']
    },
    {
        path : '/restore/config/list',
        method: 'GET',
        permissions: ['restore.read']
    },
    {
        path : '/restore/job',
        method: 'GET',
        permissions: ['restore.read']
    },
    {
        path : '/restore/job/stats',
        method: 'GET',
        permissions: ['restore.read']
    }
];

export { restorePermissions };