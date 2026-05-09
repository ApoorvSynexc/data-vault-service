import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { v4 as uuidv4 } from 'uuid';
import { docClient } from '../../config';
import { SPACE_TABLE } from '../../constant';
import { ISpace } from '../../models';

const createSpace = async (ownerUserId: string): Promise<ISpace> => {
  const now = new Date().toISOString();
  const space: ISpace = {
    spaceId: uuidv4(),
    ownerUserId,
    memberUserIds: [ownerUserId],
    createdAt: now,
    updatedAt: now,
  };

  await docClient.send(
    new PutCommand({
      TableName: SPACE_TABLE,
      Item: space,
    })
  );

  return space;
};

const getSpaceById = async (spaceId: string): Promise<ISpace | null> => {
  const result = await docClient.send(
    new GetCommand({
      TableName: SPACE_TABLE,
      Key: { spaceId },
    })
  );
  return (result.Item as ISpace) ?? null;
};

const addMemberToSpace = async (spaceId: string, userId: string): Promise<void> => {
  await docClient.send(
    new UpdateCommand({
      TableName: SPACE_TABLE,
      Key: { spaceId },
      UpdateExpression: 'ADD memberUserIds :uid',
      ExpressionAttributeValues: {
        ':uid': new Set([userId]),
      },
    })
  );
};

export { createSpace, getSpaceById, addMemberToSpace };
