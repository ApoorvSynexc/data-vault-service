export const defaultPermissions = [
    {
        label: "Dashboard",
        value: "dashboard",
        description: "Overview metrics and system health",
        permissions: [
            {
                label: "View",
                value: "read",
                description: "See dashboard metrics and status"
            }
        ]
    },
    {
        label: "Backup",
        value: "backup",
        description: "Take & manage snapshots",
        permissions: [
            {
                label: "View",
                value: "read",
                description: "See backups & history",
            },
            {
                label: "Config",
                value: "write",
                description: "Edit backup policies & jobs",
            },
            {
                label: "Execute",
                value: "execute",
                description: "Run a backup job",
                risky: true,
            },
            {
                label: "Delete",
                value: "delete",
                description: "Delete a backup or snapshot",
                risky: true,
            }
        ]
    },
    {
        label: "Archival",
        value: "archival",
        description: "Move data to cold storage",
        permissions: [
            {
                label: "View",
                value: "read",
                description: "See archives & history",
            },
            {
                label: "Config",
                value: "write",
                description: "Edit archival policies & jobs",
            },
            {
                label: "Execute",
                value: "execute",
                description: "Run an archival job",
                risky: true,
            },
            {
                label: "Delete",
                value: "delete",
                description: "Delete archived records",
                risky: true,
            }
        ]
    },
    {
        label: "Restore",
        value: "restore",
        description: "Restore data back to Salesforce",
        permissions: [
            {
                label: "View",
                value: "read",
                description: "See retrievals & history",
            },
            {
                label: "Config",
                value: "write",
                description: "Edit retrieval policies & jobs",
            },
            {
                label: "Execute",
                value: "execute",
                description: "Run a retrieval job",
                risky: true,
            },
            {
                label: "Delete",
                value: "delete",
                description: "Delete a retrieval job or its log",
                risky: true,
            }
        ]
    },
    {
        label: "Source Connection",
        value: "sourceConnection",
        description: "Connections data is pulled from",
        permissions: [
            {
                label: "View",
                value: "read",
                description: "See source connections",
            },
            {
                label: "Config",
                value: "write",
                description: "Add or edit source connections",
            }
        ]
    },
    {
        label: "Destination Connection",
        value: "destinationConnection",
        description: "Connections data is written to",
        permissions: [
            {
                label: "View",
                value: "read",
                description: "See destination connections",
            },
            {
                label: "Config",
                value: "write",
                description: "Add or edit destination connections",
            },
            {
                label: "Delete",
                value: "delete",
                description: "Remove a destination connection",
                risky: true,
            }
        ]
    },
    {
        label: "Storage",
        value: "storage",
        description: "Storage usage and capacity",
        permissions: [
            {
                label: "View",
                value: "read",
                description: "See storage usage"
            }
        ]
    },
    // {
    //     label: "Activity Logs",
    //     value: "activitylogs",
    //     description: "System and user activity history",
    //     permissions: [
    //         {
    //             label: "View",
    //             value: "read",
    //             description: "See activity logs"
    //         }
    //     ]
    // },
    // {
    //     label: "Report",
    //     value: "report",
    //     description: "Usage and compliance reporting",
    //     permissions: [
    //         {
    //             label: "View",
    //             value: "read",
    //             description: "See reports"
    //         }
    //     ]
    // },
    // {
    //     label: "Security",
    //     value: "security",
    //     description: "Encryption and access security settings",
    //     permissions: [
    //         {
    //             label: "View",
    //             value: "read",
    //             description: "See security settings"
    //         }
    //     ]
    // },

    {
        label: "Settings",
        value: "settings",
        description: "Org-wide DataVault configuration",
        permissions: [
            {
                label: "View",
                value: "read",
                description: "See settings"
            },
            {
                label: "Config",
                value: "write",
                description: "Edit settings"
            }
        ]
    },
];
