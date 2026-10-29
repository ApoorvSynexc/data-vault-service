const destinationPermissions = [
    {
        path: '/destination',
        method: 'GET',
        permissions: ['destinationConnection.read']
    },
    {
        path: '/destination/list',
        method: 'GET',
        permissions: ['destinationConnection.read']
    },
    {
        path: '/destination/config',
        method: 'GET',
        permissions: ['destinationConnection.read']
    },
    {
        path: '/destination/role-setup',
        method: 'GET',
        permissions: ['destinationConnection.write']
    },
    {
        path: '/destination/resolve-bucket-region',
        method: 'GET',
        permissions: ['destinationConnection.write']
    },
    {
        path: '/destination/test-connection',
        method: 'POST',
        permissions: ['destinationConnection.write']
    },
    {
        path: '/destination',
        method: 'POST',
        permissions: ['destinationConnection.write']
    },
    {
        path: '/destination',
        method: 'PUT',
        permissions: ['destinationConnection.write']
    },
    {
        path: '/destination',
        method: 'DELETE',
        permissions: ['destinationConnection.delete']
    }
];

export { destinationPermissions };