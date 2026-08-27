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
