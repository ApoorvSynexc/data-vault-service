import { EMRServerlessClient, StartJobRunCommand } from '@aws-sdk/client-emr-serverless';
import { getBackupConfigById } from '../../backup-config';
import { getCrmById } from '../../crm';
import { getDestinationById } from '../../destination';
import { getBackupJobsByConfig } from '../../backup-job';
import { AWS_EMR_APPLICATION_ID, AWS_EMR_ENCRYPTION_KEY, AWS_EMR_EXECUTION_ROLE_ARN, AWS_REGION } from '../../../constant';
import { logger } from '../../../middlewares';

    const client = new EMRServerlessClient({ region: AWS_REGION });

// ─── Process object operations from backup jobs ────────────────────────────────
function processObjectOperations(jobs: any[]): Record<string, string[]> {
    const objectOperations: Record<string, string[]> = {};

    for (const job of jobs) {
        const jobObjects = job.object ?? [];
        for (const obj of jobObjects) {
            if (!objectOperations[obj.name]) {
                objectOperations[obj.name] = [];
            }

            const operations = objectOperations[obj.name];
            const allOpsFound = ['inserts', 'updates', 'deletes', 'undeletes'].every((op) =>
                operations.includes(op)
            );
            if (allOpsFound) {
                continue;
            }

            if (obj.insertCount > 0 && !operations.includes('inserts')) {
                operations.push('inserts');
            }
            if (obj.updateCount > 0 && !operations.includes('updates')) {
                operations.push('updates');
            }
            if (obj.deleteCount > 0 && !operations.includes('deletes')) {
                operations.push('deletes');
            }
        }
    }

    return objectOperations;
}

// ─── Fetch all backup jobs with pagination ────────────────────────────────────

async function fetchAllBackupJobs(backupConfigId: string): Promise<any[]> {
    const allJobs: any[] = [];
    let cursor: string | undefined;

    do {
        const result = await getBackupJobsByConfig(backupConfigId, { limit: 100, cursor });
        allJobs.push(...result.items);
        cursor = result.nextCursor;
    } while (cursor);

    return allJobs;
}

// ─── Build payload from payloadHandler logic ──────────────────────────────────

async function buildPayload(backupConfigId: string): Promise<any> {
    const backupConfig = await getBackupConfigById(backupConfigId);
    if (!backupConfig) {
        throw new Error('Backup config not found');
    }

    const crm = await getCrmById(backupConfig.crmId);
    if (!crm) {
        throw new Error('CRM not found');
    }

    const destination = await getDestinationById(backupConfig.destinationId);
    if (!destination) {
        throw new Error('Destination not found');
    }

    const allBackupJobs = await fetchAllBackupJobs(backupConfigId);
    if (!allBackupJobs.length) {
        throw new Error('No backup jobs found');
    }

    const objectOperations = processObjectOperations(allBackupJobs ?? []);

    return {
        jobType: 'BACKUP',
        backupConfigId: backupConfigId,
        details: {
            clientId: backupConfig.userId,
            backupType: backupConfig.schedule,
            sourceDetails: {
                sourceName: crm.crmName,
                orgId: crm.crmId,
            },
            objectOperations,
            destinationConfigs: {
                destinationName: destination.provider,
                ciphertext: destination.ciphertext,
                iv: destination.iv,
                salt: destination.userId,
            },
        },
    };
}

// ─── Submit to EMR Serverless ─────────────────────────────────────────────────

async function initalizePayloadTransform(
    backupConfigId: string,
): Promise<any> {
    const payload = await buildPayload(backupConfigId);
    const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64');

    logger.info('Initializing EMR job...');
    console.log('──────────────────────────────────────────');
    console.log('  DataVault — EMR Serverless Job Submitter');
    console.log('──────────────────────────────────────────');
    console.log('Job Type        :', payload.jobType);
    console.log('Backup Config ID:', payload.backupConfigId);
    console.log('Destination     :', payload.details.destinationConfigs.destinationName);
    console.log('──────────────────────────────────────────');


    const command = new StartJobRunCommand({
        applicationId: AWS_EMR_APPLICATION_ID,
        executionRoleArn: AWS_EMR_EXECUTION_ROLE_ARN,
        jobDriver: {
            sparkSubmit: {
                entryPoint: "s3://jar-files-360datavault/JAR/DEV/latest/datavault-1.0.0.jar",
                entryPointArguments: [payloadB64],
                sparkSubmitParameters: "--class com.example.Main --conf spark.serializer=org.apache.spark.serializer.KryoSerializer --conf spark.hadoop.fs.s3a.impl=org.apache.hadoop.fs.s3a.S3AFileSystem --conf spark.hadoop.fs.s3a.connection.maximum=50 --conf spark.hadoop.fs.s3a.connection.timeout=60000 --conf spark.hadoop.fs.s3a.connection.establish.timeout=15000 --conf spark.hadoop.fs.s3a.attempts.maximum=3 --conf spark.hadoop.fs.s3a.retry.limit=3 --conf spark.hadoop.fs.s3a.retry.throttle.limit=5 --conf spark.hadoop.fs.s3a.paging.maximum=1000 --conf spark.network.timeout=600s --conf spark.executor.heartbeatInterval=60s --conf spark.hadoop.fs.s3a.fast.upload=true --conf spark.dynamicAllocation.executorIdleTimeout=600s --conf spark.driver.memory=4g --conf spark.driver.cores=2 --conf spark.executor.memory=8g --conf spark.executor.cores=4 --conf spark.dynamicAllocation.minExecutors=1 --conf spark.dynamicAllocation.initialExecutors=2 --conf spark.dynamicAllocation.maxExecutors=4",
            },
        },
        configurationOverrides: {
            "applicationConfiguration": [
                {
                    "classification": "spark-defaults",
                    "properties": {
                        "spark.executorEnv.ENCRYPTION_KEY": AWS_EMR_ENCRYPTION_KEY,
                        "spark.yarn.appMasterEnv.ENCRYPTION_KEY": AWS_EMR_ENCRYPTION_KEY,
                        "spark.driver.extraJavaOptions": `-DENCRYPTION_KEY=${AWS_EMR_ENCRYPTION_KEY}`,
                        "spark.executor.extraJavaOptions": `-DENCRYPTION_KEY=${AWS_EMR_ENCRYPTION_KEY}`
                    }
                }
            ],
            "monitoringConfiguration": {
                "managedPersistenceMonitoringConfiguration": {
                    "enabled": true
                },
                "cloudWatchLoggingConfiguration": {
                    "enabled": true,
                    "logGroupName": "/aws/emr-serverless"
                }
            }
        },
    });

    const response = await client.send(command);

    console.log('Job submitted successfully! ', JSON.stringify({response}));
    logger.info('EMR job initialized.');
    return response;
}

export {
    initalizePayloadTransform,
};
