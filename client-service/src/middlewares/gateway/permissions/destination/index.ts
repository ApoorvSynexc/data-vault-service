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