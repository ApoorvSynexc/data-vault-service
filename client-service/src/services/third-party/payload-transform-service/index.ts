import { EMRServerlessClient, StartJobRunCommand, StartJobRunCommandOutput } from '@aws-sdk/client-emr-serverless';
import { getBackupConfigById } from '../../backup-config';
import { getCrmById } from '../../crm';
import { getDestinationById } from '../../destination';
import { getBackupJobsByConfig } from '../../backup-job';
import { AWS_EMR_APPLICATION_ID, AWS_EMR_ENCRYPTION_KEY, AWS_EMR_EXECUTION_ROLE_ARN, AWS_REGION } from '../../../constant';
import { logger } from '../../../middlewares';
import { IBackupConfig, IBackupJob } from '../../../models';
import { flattenBackupObjects } from '../../../utils/helper';

const client = new EMRServerlessClient({ region: AWS_REGION });


// ─── Process object operations from backup jobs ────────────────────────────────
function processArchivalObjectOperations(jobs: IBackupJob[]): Record<string, string[]> {
    const objectOperations: Record<string, string[]> = {};

    for (const job of jobs) {
        const jobObjects = flattenBackupObjects(job.object ?? []) ?? [];

        if (job.jobType === "BULK") {
            for (const obj of jobObjects) {
                if (!objectOperations[obj.name]) {
                    objectOperations[obj.name] = [];
                }

                const operations = objectOperations[obj.name];
                const allOpsFound = ['inserts'].every((op) =>
                    operations.includes(op)
                );
                if (allOpsFound) {
                    continue;
                }

                if (obj.completedRecordCount && obj.completedRecordCount > 0 && !operations.includes('inserts')) {
                    operations.push('inserts');
                }
            }
        }
    }

    return objectOperations;
}

// ─── Process object operations from backup jobs ────────────────────────────────
function processObjectOperations(jobs: IBackupJob[]): Record<string, string[]> {
    const objectOperations: Record<string, string[]> = {};

    for (const job of jobs) {
        const jobObjects = job.object ?? [];

        if (job.jobType === "BULK") {
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

                if (obj.insertCount && obj.insertCount > 0 && !operations.includes('inserts')) {
                    operations.push('inserts');
                }
                if (obj.updateCount && obj.updateCount > 0 && !operations.includes('updates')) {
                    operations.push('updates');
                }
                if (obj.deleteCount && obj.deleteCount > 0 && !operations.includes('deletes')) {
                    operations.push('deletes');
                }
            }
        } else if (job.jobType === "REALTIME" && job.objectApiName) {
            if (!objectOperations[job.objectApiName]) {
                objectOperations[job.objectApiName] = [];
            }

            const operations = objectOperations[job.objectApiName];
            const allOpsFound = ['inserts', 'updates', 'deletes', 'undeletes'].every((op) =>
                operations.includes(op)
            );
            if (allOpsFound) {
                continue;
            }

            if (job.operation === 'INSERT' && !operations.includes('inserts')) {
                operations.push('inserts');
            }
            if (job.operation === 'UPDATE' && !operations.includes('updates')) {
                operations.push('updates');
            }
            if (job.operation === 'DELETE' && !operations.includes('deletes')) {
                operations.push('deletes');
            }
            if (job.operation === 'UNDELETE' && !operations.includes('undeletes')) {
                operations.push('undeletes');
            }
        }
    }

    return objectOperations;
}

// Schema chnage detection 
function archivalSchemaChangeDetection(backupConfig: IBackupConfig, objectOperations: Record<string, string[]>): Record<string, string[]> {
    const objects = flattenBackupObjects(backupConfig.objects ?? []) ?? [];
    const objectOperationsKeys = Object.keys(objectOperations);

    for (const obj of objects) {
        if (obj.schemaChange && objectOperationsKeys.includes(obj.name) && !objectOperations[obj.name].includes("schema-change")) {
            console.log("Schema chnage detect: ", { name: obj.name });
            objectOperations[obj.name].push("schema-change");
        }
    }

    return objectOperations;
}

// Schema chnage detection 
function schemaChangeDetection(backupConfig: IBackupConfig, objectOperations: Record<string, string[]>): Record<string, string[]> {
    const objects = backupConfig.objects ?? [];
    const objectOperationsKeys = Object.keys(objectOperations);

    for (const obj of objects) {
        if (obj.schemaChange && objectOperationsKeys.includes(obj.name) && !objectOperations[obj.name].includes("schema-change")) {
            console.log("Schema chnage detect: ", { name: obj.name });
            objectOperations[obj.name].push("schema-change");
        }
    }

    return objectOperations;
}

// ─── Fetch all backup jobs with pagination ────────────────────────────────────
async function fetchAllBackupJobs(backupConfigId: string) {
    try {
        const allJobs = [];
        let cursor: string | undefined;

        do {
            const result = await getBackupJobsByConfig(backupConfigId, { limit: 100, cursor });
            allJobs.push(...result.items);
            cursor = result.nextCursor;
        } while (cursor);

        return allJobs;
    } catch (error) {
        throw error;
    }
}

// ─── Build payload from payloadHandler logic ──────────────────────────────────

async function buildPayload(backupConfigId: string) {
    try {
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

        let objectOperations = backupConfig.type === 'NORMAL' ?
            processObjectOperations(allBackupJobs ?? []) :
            processArchivalObjectOperations(allBackupJobs ?? []);
        objectOperations = backupConfig.type === 'NORMAL' ?
            schemaChangeDetection(backupConfig, objectOperations) :
            archivalSchemaChangeDetection(backupConfig, objectOperations);

        return {
            jobType: backupConfig.type === 'NORMAL' ? 'BACKUP' : 'ARCHIVAL',
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
    } catch (error) {
        throw error;
    }
}

// ─── Submit to EMR Serverless ─────────────────────────────────────────────────

async function initalizePayloadTransform(
    backupConfigId: string,
): Promise<StartJobRunCommandOutput> {
    try {
        const payload = await buildPayload(backupConfigId);
        const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64');

        logger.info('Initializing EMR job...');
        console.log('──────────────────────────────────────────');
        console.log('  DataVault — EMR Serverless Job Submitter');
        console.log('──────────────────────────────────────────');
        console.log('executionRoleArn:', AWS_EMR_EXECUTION_ROLE_ARN);
        console.log('Job Type        :', payload.jobType);
        console.log('Backup Config ID:', payload.backupConfigId);
        console.log('Destination     :', payload.details.destinationConfigs.destinationName);
        console.log('──────────────────────────────────────────');

        // Spark submit parameters — tuned for 100 GB / 200 objects in 5 minutes.
        // Kept as an array + .join(' ') so each setting is reviewable in isolation;
        // EMR receives the joined single-line string at submit time.
        const sparkSubmitParameters = [
            '--class com.example.Main',

            // Serialization
            '--conf spark.serializer=org.apache.spark.serializer.KryoSerializer',
            '--conf spark.kryo.registrator=org.apache.spark.HoodieSparkKryoRegistrar',

            // S3A filesystem + throughput
            '--conf spark.hadoop.fs.s3a.impl=org.apache.hadoop.fs.s3a.S3AFileSystem',
            '--conf spark.hadoop.fs.s3a.connection.maximum=1000',
            '--conf spark.hadoop.fs.s3a.threads.max=500',
            '--conf spark.hadoop.fs.s3a.threads.keepalivetime=60',
            '--conf spark.hadoop.fs.s3a.connection.timeout=60000',
            '--conf spark.hadoop.fs.s3a.connection.establish.timeout=15000',
            '--conf spark.hadoop.fs.s3a.attempts.maximum=5',
            '--conf spark.hadoop.fs.s3a.retry.limit=5',
            '--conf spark.hadoop.fs.s3a.retry.throttle.limit=20',
            '--conf spark.hadoop.fs.s3a.paging.maximum=1000',
            '--conf spark.hadoop.fs.s3a.multipart.size=134217728',
            '--conf spark.hadoop.fs.s3a.block.size=134217728',
            '--conf spark.hadoop.fs.s3a.multipart.threshold=134217728',
            '--conf spark.hadoop.fs.s3a.fast.upload=true',
            '--conf spark.hadoop.fs.s3a.fast.upload.buffer=bytebuffer',
            '--conf spark.hadoop.fs.s3a.fast.upload.active.blocks=8',
            '--conf spark.hadoop.fs.s3a.readahead.range=4194304',

            // Network / heartbeats
            '--conf spark.network.timeout=600s',
            '--conf spark.executor.heartbeatInterval=60s',

            // Dynamic allocation — 200 executors needed for parallel object dispatch
            '--conf spark.dynamicAllocation.minExecutors=20',
            '--conf spark.dynamicAllocation.initialExecutors=50',
            '--conf spark.dynamicAllocation.maxExecutors=200',
            '--conf spark.dynamicAllocation.executorIdleTimeout=60s',
            '--conf spark.dynamicAllocation.schedulerBacklogTimeout=1s',
            '--conf spark.dynamicAllocation.sustainedSchedulerBacklogTimeout=1s',

            // Driver — coordinates 200 objects + holds metadata
            '--conf spark.driver.memory=16g',
            '--conf spark.driver.cores=8',
            '--conf spark.driver.maxResultSize=4g',

            // Executor sizing
            '--conf spark.executor.memory=16g',
            '--conf spark.executor.cores=4',
            '--conf spark.executor.memoryOverhead=4g',
            '--conf spark.memory.fraction=0.8',
            '--conf spark.memory.storageFraction=0.3',

            // Spark SQL / shuffle
            '--conf spark.sql.shuffle.partitions=800',
            '--conf spark.sql.adaptive.enabled=true',
            '--conf spark.sql.adaptive.coalescePartitions.enabled=true',
            '--conf spark.sql.adaptive.coalescePartitions.minPartitionNum=1',
            '--conf spark.sql.adaptive.skewJoin.enabled=true',
            '--conf spark.sql.adaptive.localShuffleReader.enabled=true',
            '--conf spark.sql.files.maxPartitionBytes=134217728',
            '--conf spark.sql.files.openCostInBytes=4194304',

            // Scheduler — FAIR is required for concurrent object dispatch from the driver
            '--conf spark.scheduler.mode=FAIR',
            '--conf spark.task.cpus=1',
            '--conf spark.locality.wait=0s',
            '--conf spark.speculation=false',
        ].join(' ');

        const command = new StartJobRunCommand({
            applicationId: AWS_EMR_APPLICATION_ID,
            executionRoleArn: AWS_EMR_EXECUTION_ROLE_ARN,
            jobDriver: {
                sparkSubmit: {
                    entryPoint: "s3://jar-files-360datavault/JAR/DEV/latest/datavault-1.0.0.jar",
                    entryPointArguments: [payloadB64],
                    sparkSubmitParameters,
                },
            },
            configurationOverrides: {
                applicationConfiguration: [
                    {
                        classification: "spark-defaults",
                        properties: {
                            "spark.executorEnv.ENCRYPTION_KEY": AWS_EMR_ENCRYPTION_KEY,
                            "spark.yarn.appMasterEnv.ENCRYPTION_KEY": AWS_EMR_ENCRYPTION_KEY,
                            "spark.driver.extraJavaOptions": `-DENCRYPTION_KEY=${AWS_EMR_ENCRYPTION_KEY}`,
                            "spark.executor.extraJavaOptions": `-DENCRYPTION_KEY=${AWS_EMR_ENCRYPTION_KEY}`,
                        },
                    },
                ],
                monitoringConfiguration: {
                    managedPersistenceMonitoringConfiguration: { enabled: true },
                    cloudWatchLoggingConfiguration: {
                        enabled: true,
                        logGroupName: "/aws/emr-serverless",
                    },
                },
            },
        });

        const response = await client.send(command);
        logger.info('EMR job initialized.');
        return response;
    } catch (error) {
        logger.error('Error initializing EMR job:', error);
        throw error;
    }
}


export {
    initalizePayloadTransform,
};
