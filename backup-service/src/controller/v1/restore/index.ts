import { IRequest, IResponse, makeResponse } from "../../../lib";
import { wrapController } from "../../../utils/helper";

const createRestoreJobHandler = async (req: IRequest, res: IResponse): Promise<void> => {
  const { restoreId } = req.query as { restoreId: string };
  

  makeResponse(req, res, 200, true, 'create');
};

export const createRestoreController = wrapController({
  createRestoreJobHandler,
});