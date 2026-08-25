const archivalConfigPermissions = [
    {
        path: '/archival-config/list',
        method: 'GET',
        permissions: ['archival.read']
    },
    {
        path: '/archival-config/fields',
        method: 'GET',
        permissions: ['archival.read']
    },
    {
        path: '/archival-config/get-picklist-field-values',
        method: 'GET',
        permissions: ['archival.read']
    },
    {
        path: '/archival-config/object-childs',
        method: 'GET',
        permissions: ['archival.read']
    },
    {
        path: '/archival-config/validate-soql',
        method: 'POST',
        permissions: ['archival.read']
    },
    {
        path: '/archival-config/dry-run',
        method: 'POST',
        permissions: ['archival.read']
    },
    {
        path: '/archival-config/object-records',
        method: 'POST',
        permissions: ['archival.read']
    },
    {
        path: '/archival-config',
        method: 'POST',
        permissions: ['archival.write']
    },
    {
        path: '/archival-config',
        method: 'GET',
        permissions: ['archival.read']
    },
    {
        path: '/archival-config',
        method: 'PUT',
        permissions: ['archival.write']
    },
    {
        path: '/archival-config',
        method: 'DELETE',
        permissions: ['archival.delete']
    },
    {
        path: '/archival-config/stats',
        method: 'GET',
        permissions: ['archival.read']
    },
    {
        path : '/archival-config/record-errors',
        method : 'GET',
        permissions : ['archival.read']
    },
];

export { archivalConfigPermissions };