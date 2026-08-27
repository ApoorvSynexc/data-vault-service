// Mirrors client-service/src/models/notification/index.ts — client-service owns
// reads/updates on this table (its notification API); backup-service only
// writes to it (see services/notification), so the shape must stay identical.
export interface INotification {
  notificationId: string; // PK
  userId: string; // GSI: userId-index (+ createdAt sort, latest first)
  crmId: string;
  title: string;
  body: string;
  targetScreen?: string;
  targetId?: string;
  status: string; // UNREAD | READ | DELETED
  createdAt: string;
  updatedAt: string;
}
