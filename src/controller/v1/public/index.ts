import { IRequest, IResponse, makeResponse } from "../../../lib";
import { wrapController } from "../../../utils/helper";

const salesForceealTimeHandler = async (req: IRequest, res: IResponse): Promise<void> => {
    makeResponse(req, res, 200, true, 'fetch');
};

export const publicController = wrapController({
    salesForceealTimeHandler
});