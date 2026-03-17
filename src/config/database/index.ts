import mongoose from 'mongoose';
import { HOST, PORT, DB, USER, PASSWORD } from '../../constant';

const initializeDatabase = () =>
  new Promise(async (resolve, reject) => {
    try {
      const db = await mongoose.connect(`mongodb://${HOST}:${PORT}/${DB}`, {
        auth: {
          username: USER,
          password: PASSWORD,
        },
      });

      console.log('Database connection established');
      resolve(db);
    } catch (err) {
      reject(err);
    }
  });

export default initializeDatabase;
