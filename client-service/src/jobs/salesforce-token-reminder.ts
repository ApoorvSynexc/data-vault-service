import { logger } from "../middlewares";
import { sendReconnectReminder } from "../services";

// P7 — sends reconnect reminder `seq` for an Expired user and schedules the
// next one. sendReconnectReminder claims the sequence number with a
// conditional write, so duplicate deliveries and reminders for a user who has
// since reconnected are no-ops.
const runSalesforceTokenReminder = async (params: { userId: string; seq: number }) => {
    try {
        await sendReconnectReminder(params.userId, Number(params.seq));
    } catch (error) {
        logger.error(`[salesforce token reminder] user ${params.userId} seq ${params.seq} failed: ${(error as Error)?.message ?? String(error)}`);
    }
};

export {
    runSalesforceTokenReminder
};
