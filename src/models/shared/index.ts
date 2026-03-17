import { Schema } from 'mongoose';

export const addressSchema = new Schema(
  {
    street: String,
    street2: String,
    city: String,
    cityId: String,
    state: String,
    stateIso2: String,
    stateId: String,
    country: String,
    iso2: {
      type: String,
      uppercase: true,
      max: 2,
    },
    countryId: String,
    zipCode: {
      type: String,
    },
    geo: {
      type: {
        type: String,
        enum: ['Point'],
        required: true,
        default: 'Point',
      },
      coordinates: {
        type: [Number], // [longitude, latitude]
        default: [0, 0],
        required: true,
      },
    },
  },
  { _id: false }
);

addressSchema.index({ geo: '2dsphere' });

export const phoneSchema = new Schema(
  {
    dialCode: String,
    iso2: {
      type: String,
      uppercase: true,
      max: 2,
    },
    country: {
      type: String,
      uppercase: true,
    },
    number: String,
  },
  { _id: false }
);

export const mediaSchema = new Schema(
  {
    name: String,
    thumbnailUrl: String,
    url: String,
    type: String,
    size: Number,
  },
  { _id: false }
);
