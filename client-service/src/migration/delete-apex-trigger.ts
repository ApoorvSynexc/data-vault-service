import { deleteTriggers, getUserByCrmProfileUserId } from "../services"
import { decrypt } from "../utils/encryption";

export const deleteUserTrigger = async () => {
    try {
        const backupConfig: any = {
            triggerResults: [
                {
                    triggerName: "DataVault__Account_Trigger"
                }
            ]
        }
        const user = await getUserByCrmProfileUserId("005dN00000B4141QAB");
        if (user && user.crmCredential && user.crmProfile?.instanceUrl) {
            console.log("Deleting trigger");

            const tokens = JSON.parse(decrypt(user.crmCredential));
            console.log({tokens});
            const count = await deleteTriggers(
                user.crmProfile?.instanceUrl,
                {
                    accessToken: "00DdN00000wY1pt!AQEAQCkRxVV1ajMnqGE0SjmpOjMfUE9nW4PLVvOE3yI7SHDUZhkCg8_t4hcLzUP3Gv5jBFTnlD9MaceKjDdoE6e.5yBvmwAu",
                    refreshToken: tokens.refresh_token,
                },
                backupConfig
            );
            console.log(`Trigger deleted length: ${count}`);
        }
    } catch (error) {
        console.log("Error in migration: ", error);

    }
}