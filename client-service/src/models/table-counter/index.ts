export interface ITableCounter {
  tableName: string;
  entityId: string; // 'GLOBAL' or userId
  count: number;
  updatedAt: string;
}
