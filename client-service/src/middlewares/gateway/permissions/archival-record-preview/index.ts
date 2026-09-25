// Routes are mounted under the existing '/archival-config' base path (see
// routes/v1/index.ts), alongside archivalConfigPermissions — merged into that
// same "archival-config" aclGateway key (see permissions/index.ts) so a role
// that already has archival.* access covers these routes too.
const archivalRecordPreviewPermissions = [
    {
        path: '/archival-config/salesforce/preview',
        method: 'POST',
        permissions: ['archival.read']
    },
    {
        path: '/archival-config/salesforce/record-detail',
        method: 'POST',
        permissions: ['archival.read']
    }
];

export { archivalRecordPreviewPermissions };
