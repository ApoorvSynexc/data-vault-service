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
                    accessToken: tokens.access_token,
                    refreshToken: tokens.refresh_token,
                },
                backupConfig
            );
            console.log(`Trigger deleted length: ${count.length}`);
        }
    } catch (error) {
        console.log("Error in migration: ", error);

    }
}