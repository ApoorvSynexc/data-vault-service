import { OTP } from '../../models';

const createOtp = (data: object) => OTP.create(data);

const getOtp = async (search = {}, projection: object = { __v: 0 }) =>
  OTP.aggregate([
    { $match: search },
    { $sort: { _id: -1 } },
    { $project: projection },
  ]).then((result) => result[0] || null);

const updateOtp = (search = {}, payload = {}, options = {}) =>
  OTP.findOneAndUpdate(search, payload, options);

export { createOtp, getOtp, updateOtp };
