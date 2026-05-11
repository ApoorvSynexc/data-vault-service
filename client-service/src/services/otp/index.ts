import { PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { v4 as uuidv4 } from 'uuid';
import { docClient } from '../../config';
import { OTP_TABLE } from '../../constant';
import { IOtp, IOtpId, IPhone } from '../../models';

// ---------------------------------------------------------------------------
// DynamoDB table layout
//
//   Main table
//     PK: otpId      (UUID v4)
//     SK: createdAt  (ISO string)
//
//   GSI  "contact-otptype-index"
//     PK: contactOtpKey  — "email#user@example.com#SIGNUP"
//                        | "mobile#+919876543210#SIGNUP"
//     SK: createdAt      — enables "get latest OTP for this contact+type"
//
// upsert: queries GSI first — updates in place if record exists, inserts new if not.
// getOtp: queries GSI, takes the most recent match, filters in memory.
// ---------------------------------------------------------------------------

const buildContactKey = (search: Record<string, any>): string => {
  if (search['contact.email']) {
    return `email#${search['contact.email']}`;
  }
  if (search['contact.mobile']) {
    const m = search['contact.mobile'] as IPhone;
    return `mobile#${m.dialCode}${m.number}`;
  }
  return '';
};

const buildContactOtpKey = (search: Record<string, any>): string => {
  const contactKey = buildContactKey(search);
  const otpType = search.otpType ?? (search as any).otpType;
  return `${contactKey}#${otpType}`;
};

const buildContactObject = (
  search: Record<string, any>,
  payload: Record<string, any>
): IOtp['contact'] | undefined => {
  const emailVal = payload['contact.email'] ?? search['contact.email'];
  const mobileVal = payload['contact.mobile'] ?? search['contact.mobile'];
  if (emailVal) {
    return { email: emailVal };
  }
  if (mobileVal) {
    return { mobile: mobileVal as IPhone };
  }
  return undefined;
};

// ---------------------------------------------------------------------------

const createOtp = async (data: Record<string, any>): Promise<void> => {
  const now = new Date().toISOString();
  const contactKey = buildContactKey(data);
  const item = {
    otpId: uuidv4(),
    createdAt: now,
    contactOtpKey: `${contactKey}#${data.otpType}`,
    contact: data.contact,
    otp: data.otp,
    expiresAt: data.expiresAt instanceof Date ? data.expiresAt.toISOString() : data.expiresAt,
    otpType: data.otpType,
    channel: data.channel,
    status: data.status,
    otpFor: data.otpFor,
    updatedAt: now,
  };
  await docClient.send(new PutCommand({ TableName: OTP_TABLE, Item: item }));
};

const getOtp = async (search: Record<string, any>): Promise<IOtp | null> => {
  const contactOtpKey = buildContactOtpKey(search);
  if (!contactOtpKey.includes('#')) {
    return null;
  }

  // Query GSI — sorted by createdAt DESC, take first result
  const result = await docClient.send(
    new QueryCommand({
      TableName: OTP_TABLE,
      IndexName: 'contact-otptype-index',
      KeyConditionExpression: 'contactOtpKey = :key',
      ProjectionExpression: 'otpId, createdAt, contactOtpKey, contact, otp, expiresAt, otpType, channel, #status, otpFor, updatedAt',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':key': contactOtpKey },
      ScanIndexForward: false, // descending createdAt → latest first
      Limit: 10, // small window; filtered below
    })
  );

  const items = (result.Items ?? []) as IOtp[];

  // In-memory filters (mirrors MongoDB $match on remaining fields)
  const match = items.find((item) => {
    if (search.otp !== undefined && item.otp !== search.otp) {
      return false;
    }
    if (search.status !== undefined && item.status !== search.status) {
      return false;
    }
    if (search.channel !== undefined && item.channel !== search.channel) {
      return false;
    }
    return true;
  });

  if (!match) {
    return null;
  }
  return { ...match, _id: { otpId: match.otpId, createdAt: match.createdAt } };
};

const updateOtp = async (
  search: Record<string, any>,
  payload: Record<string, any>
): Promise<void> => {
  const now = new Date().toISOString();

  // ── Case 1: update by composite _id (e.g. mark status = verified) ─────────
  if (search._id) {
    const { otpId, createdAt } = search._id as IOtpId;
    const $set: Record<string, any> = (payload as any).$set ?? {};

    const names: Record<string, string> = { '#updatedAt': 'updatedAt' };
    const values: Record<string, any> = { ':updatedAt': now };
    const parts: string[] = ['#updatedAt = :updatedAt'];

    Object.entries($set).forEach(([key, val], i) => {
      names[`#f${i}`] = key;
      values[`:v${i}`] = val;
      parts.push(`#f${i} = :v${i}`);
    });

    await docClient.send(
      new UpdateCommand({
        TableName: OTP_TABLE,
        Key: { otpId, createdAt },
        UpdateExpression: `SET ${parts.join(', ')}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      })
    );
    return;
  }

  // ── Case 2: upsert — insert fresh OTP (old ones expire via TTL) ────────────
  const contactKey = buildContactKey(search);
  if (!contactKey) {
    return;
  }

  const otpType = (payload as any).otpType ?? search.otpType;
  const contactOtpKey = `${contactKey}#${otpType}`;
  const expiresAt = (payload as any).expiresAt;
  const expiresAtStr = expiresAt instanceof Date ? expiresAt.toISOString() : expiresAt;

  // Create fresh OTP record. Old OTPs for same contact+type are auto-cleaned via TTL.
  // This is simpler and cheaper than Query + Update: single Put operation instead of 2 calls.
  const item: Record<string, any> = {
    otpId: uuidv4(),
    createdAt: now,
    contactOtpKey,
    contact: buildContactObject(search, payload),
    otp: (payload as any).otp,
    expiresAt: expiresAtStr,
    otpType,
    channel: (payload as any).channel,
    status: (payload as any).status,
    otpFor: (payload as any).otpFor,
    updatedAt: now,
  };

  Object.keys(item).forEach((k) => item[k] === undefined && delete item[k]);

  await docClient.send(new PutCommand({ TableName: OTP_TABLE, Item: item }));
};

export { createOtp, getOtp, updateOtp };
