import { USER } from '../../models';

const createUser = (data: object) => USER.create(data);

const updateUser = (search = {}, payload = {}, options = {}) =>
  USER.findOneAndUpdate(search, payload, options);

const getUser = async (search = {}, projection: object = { __v: 0 }) =>
  USER.aggregate([
    { $match: search },
    { $sort: { _id: -1 } },
    {
      $project: projection,
    },
  ]).then((result) => result[0] || null);

const getUsers = async (search = {}, projection: object = { __v: 0 }) =>
  USER.aggregate([
    { $match: search },
    { $sort: { _id: -1 } },
    {
      $project: projection,
    },
  ]);

const getUsersWithPagination = async (
  search = {},
  projection: object = { __v: 0 },
  optional: { skip: number; limit: number }
) => {
  const pipeline = [{ $match: search }];
  return USER.aggregate([
    {
      $facet: {
        documents: [
          ...pipeline,
          { $sort: { _id: -1 } },
          { $skip: optional.skip },
          { $limit: optional.limit },
          {
            $project: projection,
          },
        ],
        total: [...pipeline, { $count: 'count' }],
      },
    },
    {
      $unwind: { path: '$total', preserveNullAndEmptyArrays: true },
    },
  ]).then((result) => result[0] || null);
};

export { createUser, getUser, updateUser, getUsers, getUsersWithPagination };
