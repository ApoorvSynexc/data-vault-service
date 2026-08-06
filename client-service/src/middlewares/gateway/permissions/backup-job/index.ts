const backupJobPermissions = [
    {
        path: '/backup-job/list',
        method: 'GET',
        permissions: ['backup.read']
    },
    {
        path: '/backup-job',
        method: 'GET',
        permissions: ['backup.read']
    },
    {
        path: '/backup-job/resume',
        method: 'GET',
        permissions: ['backup.execute']
    }
];

export { backupJobPermissions };
