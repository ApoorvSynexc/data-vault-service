import { EMRServerlessClient, StartJobRunCommand, StartJobRunCommandOutput } from '@aws-sdk/client-emr-serverless';
import { getBackupConfigById } from '../backup-config';
import { getCrmById } from '../crm';
import { getDestinationById, getDecryptedDestinationConfig } from '../destination';
import { getBackupJobsByConfig, getBackupJobById } from '../backup-job';
import { getRestoreById } from '../restore';
import { AWS_EMR_ACCESS_KEY_ID, AWS_EMR_APPLICATION_ID, AWS_EMR_ENCRYPTION_KEY, AWS_EMR_EXECUTION_ROLE_ARN, AWS_EMR_REGION, AWS_EMR_SECRET_ACCESS_KEY, JOB_STATUS, SCHEDULE_MODE } from '../../constant';
import { runRealtimeSchemaSync } from './schema-sync';
import { logger } from '../../middlewares';
import { IBackupConfig, IBackupJob } from '../../models';
import { flattenBackupObjects } from '../../utils/helper';
import { encryptWithKey } from '../../utils/encryption';

// EMR runs in a separate AWS account — use its dedicated credentials, not the default chain.
const client = new EMRServerlessClient({
    region: AWS_EMR_REGION,
    credentials: {
        accessKeyId: AWS_EMR_ACCESS_KEY_ID,
        secretAccessKey: AWS_EMR_SECRET_ACCESS_KEY,
    },
});

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
    const allJobs = [];
    let cursor: string | undefined;

    do {
        const result = await getBackupJobsByConfig(backupConfigId, { limit: 100, cursor });
        allJobs.push(...result.items);
        cursor = result.nextCursor;
    } while (cursor);

    return allJobs;
}

// Only successful backups that haven't entered the compression lifecycle.
// Excludes COMPRESSED (done), COMPRESSION_JOB_IN_PROGRESS (Spark already has it),
// COMPRESSION_JOB_FAILED (no auto-retry), and PENDING/RUNNING/FAILED backups.
// ponytail: no retry path — a COMPRESSION_JOB_FAILED job, or one stranded in
// COMPRESSION_JOB_IN_PROGRESS by a crashed Spark run, never re-enters the trigger and
// can't return to SUCCESS on its own, because compression overwrote `status`. Retry
// needs the separate `compressionStatus` field (see COMPRESSION_STATUS in constant/),
// which would leave `status` on SUCCESS and make the filter
// `compressionStatus IN (null, COMPRESSION_JOB_FAILED)`. Until then, stuck jobs are
// found by age via lastUpdatedAt, which setCompressionStatus already writes.
const isCompressible = (job: IBackupJob): boolean => job.status === JOB_STATUS.success;

// ─── Build EMR payload from a backupConfigId ──────────────────────────────────
// Pure builder: resolves config/crm/destination/jobs and shapes the payload Spark
// reads. objectOperations is keyed by backupJobId so Spark can compress each job's
// output independently; a job with no operations maps to {}.
//
// The job set is resolved here, not by the caller: every job on the config that
// isCompressible admits (status SUCCESS — excludes failed backups and all
// compression states, which overwrite `status`).
//
// Shape matches Spark's parser exactly (JsonUtils.java): everything but jobType and
// backupConfigId nests under `details`, creds under details.destinationConfigs.
// Destination creds are returned decrypted — this payload only ever leaves the
// process through /build-payload, whose body Spark reads as Base64(JSON) over TLS.
// Do not hand this to submitEMR — its trigger payload is intentionally id-only.
async function buildPayload(backupConfigId: string) {
    logger.info(`Building EMR payload for backupConfigId: ${backupConfigId}`);

    const backupConfig = await getBackupConfigById(backupConfigId);
    if (!backupConfig) {
        throw new Error('backup_config_not_found');
    }

    const crm = await getCrmById(backupConfig.crmId);
    if (!crm) {
        throw new Error('crm_not_found');
    }

    const destination = await getDestinationById(backupConfig.destinationId);
    if (!destination) {
        throw new Error('destination_not_found');
    }

    const allBackupJobs = await fetchAllBackupJobs(backupConfigId);
    if (!allBackupJobs.length) {
        throw new Error('No backup jobs found');
    }

    const jobs = allBackupJobs.filter(isCompressible);

    // processObjectOperations already takes a job array, so a single-job array gives that
    // job's operations with no change to the merge logic itself.
    const objectOperations: Record<string, Record<string, string[]>> = {};
    for (const job of jobs) {
        const jobOperations = backupConfig.type === 'NORMAL' ?
            processObjectOperations([job]) :
            processArchivalObjectOperations([job]);
        objectOperations[job.backupJobId] = backupConfig.type === 'NORMAL' ?
            schemaChangeDetection(backupConfig, jobOperations) :
            archivalSchemaChangeDetection(backupConfig, jobOperations);
    }

    logger.info(`Built EMR payload for backupConfigId: ${backupConfigId} jobs=${jobs.length}`);

    const payload = {
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
                destinationRequiredCreds: getDecryptedDestinationConfig(destination),
            },
        },
    };
    console.log("PAYLOAD ==> " + JSON.stringify(payload));
    return payload;
}

// ─── Build EMR RESTORE payload from a restoreConfigId ─────────────────────────
// Restore mirrors buildPayload's resolve-then-shape contract, but reads a restore
// config instead of backup jobs. The stored restore already carries selection and
// conflict in the exact shape Spark expects; the rest is resolved:
//   - backupConfig.id: restores reference backup jobs, not a config, so we recover
//     the owning config from the first selected job (all jobs share one config).
//   - sourceDetails: the CRM the backup came from.
//   - destinationConfigs: the user's restore destination + the S3 creds Spark needs
//     to read the backup files (the source config's destination bucket).
//
// Same credential rule as buildPayload: decrypted creds only ever leave through
// /build-payload, which encrypts the whole response. Never hand this to submitEMR.
async function buildRestorePayload(restoreConfigId: string) {
    logger.info(`Building EMR RESTORE payload for restoreConfigId: ${restoreConfigId}`);

    const restore = await getRestoreById(restoreConfigId);
    if (!restore) {
        throw new Error('restore_config_not_found');
    }

    const backupJobIds = restore.source?.backupJobIds ?? [];
    if (!backupJobIds.length) {
        throw new Error('restore_config_has_no_backup_jobs');
    }

    const firstJob = await getBackupJobById(backupJobIds[0]);
    if (!firstJob) {
        throw new Error(`backup_job_not_found:${backupJobIds[0]}`);
    }
    const backupConfigId = firstJob.backupConfigId;

    const backupConfig = await getBackupConfigById(backupConfigId);
    if (!backupConfig) {
        throw new Error('backup_config_not_found');
    }

    const crm = await getCrmById(backupConfig.crmId);
    if (!crm) {
        throw new Error('crm_not_found');
    }

    const destination = await getDestinationById(backupConfig.destinationId);
    if (!destination) {
        throw new Error('destination_not_found');
    }

    logger.info(`Built EMR RESTORE payload for restoreConfigId: ${restoreConfigId} jobs=${backupJobIds.length}`);

    return {
        jobType: 'RESTORE',
        restoreConfigId,
        details: {
            clientId: restore.userId,
            sourceDetails: {
                sourceName: crm.crmName,
                orgId: crm.crmId,
            },
            'restore-configs': {
                source: {
                    backupConfig: {
                        id: backupConfigId,
                        backupJobIds,
                    },
                },
                // Stored as-is in the shape Spark reads.
                selection: restore.selection,
                conflict: restore.conflict,
                restoreType: restore.restoreType ?? 'RESTORE_ONLY_CHANGED_FIELDS',
            },
            // ponytail: destinationConfigs = restore destination descriptor + the S3
            // creds Spark reads the backup from. Exact Spark contract for this block
            // was elided in the spec ("..."); revisit if Spark expects a different shape.
            destinationConfigs: {
                ...restore.destination,
                storage: {
                    name: destination.provider,
                    creds: getDecryptedDestinationConfig(destination),
                },
            },
        },
    };
}

type EmrPayload = Awaited<ReturnType<typeof buildPayload>>;

// What EMR receives as entryPointArguments. Deliberately carries no credentials —
// Spark calls /build-payload with this id for the rest, and that response is
// encrypted. Job resolution happens server-side in buildPayload (isCompressible),
// so the trigger is id-only for both backup and restore runs.
type EmrTriggerPayload =
    | { backupConfigId: string }
    | { restoreConfigId: string };

// ─── Submit a built payload to EMR Serverless ─────────────────────────────────
async function submitEMR(payload: EmrTriggerPayload): Promise<StartJobRunCommandOutput> {
    try {
        // Encrypted with AWS_EMR_ENCRYPTION_KEY (the same key Spark gets as ENCRYPTION_KEY),
        // framed like encryptToTransport: base64(JSON({ ciphertext, iv })).
        const payloadB64 = Buffer.from(
            JSON.stringify(encryptWithKey(JSON.stringify(payload), AWS_EMR_ENCRYPTION_KEY))
        ).toString('base64');

        logger.info('Initializing EMR job...');
        console.log('──────────────────────────────────────────');
        console.log('  DataVault — EMR Serverless Job Submitter');
        console.log('──────────────────────────────────────────');
        console.log('executionRoleArn:', AWS_EMR_EXECUTION_ROLE_ARN);
        if ('restoreConfigId' in payload) {
            console.log('Restore Config ID:', payload.restoreConfigId);
        } else {
            console.log('Backup Config ID:', payload.backupConfigId);
        }
        console.log('──────────────────────────────────────────');

        // Spark submit parameters — tuned for 100 GB / 200 objects in 5 minutes.
        // Kept as an array + .join(' ') so each setting is reviewable in isolation;
        // EMR receives the joined single-line string at submit time.
        const sparkSubmitParameters = [
            '--class com.example.Main',

            // Serialization
            '--conf spark.serializer=org.apache.spark.serializer.KryoSerializer',
            '--conf spark.kryo.registrator=org.apache.spark.HoodieSparkKryoRegistrar',

            // S3A
            '--conf spark.hadoop.fs.s3a.impl=org.apache.hadoop.fs.s3a.S3AFileSystem',
            '--conf spark.hadoop.fs.s3a.connection.maximum=100',
            '--conf spark.hadoop.fs.s3a.threads.max=64',
            '--conf spark.hadoop.fs.s3a.threads.keepalivetime=60',
            '--conf spark.hadoop.fs.s3a.connection.timeout=60000',
            '--conf spark.hadoop.fs.s3a.connection.establish.timeout=15000',
            '--conf spark.hadoop.fs.s3a.attempts.maximum=5',
            '--conf spark.hadoop.fs.s3a.retry.limit=5',
            '--conf spark.hadoop.fs.s3a.retry.throttle.limit=20',
            '--conf spark.hadoop.fs.s3a.paging.maximum=1000',

            '--conf spark.hadoop.fs.s3a.multipart.size=134217728',
            '--conf spark.hadoop.fs.s3a.multipart.threshold=134217728',
            '--conf spark.hadoop.fs.s3a.block.size=134217728',

            '--conf spark.hadoop.fs.s3a.fast.upload=true',
            '--conf spark.hadoop.fs.s3a.fast.upload.buffer=bytebuffer',
            '--conf spark.hadoop.fs.s3a.fast.upload.active.blocks=4',

            '--conf spark.hadoop.fs.s3a.readahead.range=4194304',

            // Network
            '--conf spark.network.timeout=600s',
            '--conf spark.executor.heartbeatInterval=60s',

            // Dynamic Allocation
            '--conf spark.dynamicAllocation.enabled=true',
            '--conf spark.dynamicAllocation.minExecutors=1',
            '--conf spark.dynamicAllocation.initialExecutors=2',
            '--conf spark.dynamicAllocation.maxExecutors=6',
            '--conf spark.dynamicAllocation.executorIdleTimeout=60s',
            '--conf spark.dynamicAllocation.schedulerBacklogTimeout=1s',
            '--conf spark.dynamicAllocation.sustainedSchedulerBacklogTimeout=1s',

            // Driver
            '--conf spark.driver.memory=8g',
            '--conf spark.driver.cores=4',
            '--conf spark.driver.maxResultSize=2g',

            // Executors
            '--conf spark.executor.memory=6g',
            '--conf spark.executor.cores=2',
            '--conf spark.executor.memoryOverhead=1g',

            '--conf spark.memory.fraction=0.8',
            '--conf spark.memory.storageFraction=0.3',

            // Spark SQL
            '--conf spark.sql.shuffle.partitions=100',
            '--conf spark.sql.adaptive.enabled=true',
            '--conf spark.sql.adaptive.coalescePartitions.enabled=true',
            '--conf spark.sql.adaptive.skewJoin.enabled=true',
            '--conf spark.sql.adaptive.localShuffleReader.enabled=true',

            '--conf spark.sql.files.maxPartitionBytes=134217728',
            '--conf spark.sql.files.openCostInBytes=4194304',

            // Scheduler
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
                    entryPoint: "s3://jar-files-360datavault/TEST/datavault-1.0.0.jar",
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
                            "spark.executorEnv.NODE_SERVER_URL": "https://deport-shady-fantastic.ngrok-free.dev",
                            "spark.yarn.appMasterEnv.NODE_SERVER_URL": "https://deport-shady-fantastic.ngrok-free.dev",
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

// ─── Trigger a compression run (used by /payload and the config trigger) ──────
// Sends only the config id. Spark calls /build-payload with it to get the full
// payload; the eligible job set is resolved there. The fetch here is only a guard
// against spinning up EMR for a config with no jobs at all.
async function initalizePayloadTransform(
    backupConfigId: string,
    opts: { skipRealtimeSync?: boolean } = {}
): Promise<StartJobRunCommandOutput | void> {
    // REALTIME configs: sync schema/picklist/record-type before compressing. On drift a
    // Schema-Sync backup job runs first and compression resumes via the
    // 'schema.sync.completed' callback (skipRealtimeSync bypasses this gate on that
    // resume so a still-changing metadata read can't loop it).
    if (!opts.skipRealtimeSync) {
        const backupConfig = await getBackupConfigById(backupConfigId);
        if (backupConfig?.schedule === SCHEDULE_MODE.realtime) {
            const deferred = await runRealtimeSchemaSync(backupConfig);
            if (deferred) {
                logger.info(`Deferred EMR for backupConfigId: ${backupConfigId} — Schema-Sync backup in progress`);
                return;
            }
        }
    }

    const backupJobs = await fetchAllBackupJobs(backupConfigId);
    if (!backupJobs.length) {
        throw new Error('No backup jobs found');
    }

    logger.info(`Triggering EMR for backupConfigId: ${backupConfigId}`);
    return submitEMR({ backupConfigId });
}

// ─── Trigger a restore run ────────────────────────────────────────────────────
// Sends only the restore config id. Spark calls /build-payload with it to get the
// full RESTORE payload (buildRestorePayload).
async function initalizeRestoreTransform(restoreConfigId: string): Promise<StartJobRunCommandOutput> {
    logger.info(`Triggering EMR RESTORE for restoreConfigId: ${restoreConfigId}`);
    return submitEMR({ restoreConfigId });
}

export {
    buildPayload,
    buildRestorePayload,
    submitEMR,
    initalizePayloadTransform,
    initalizeRestoreTransform,
    isCompressible,
    // exported for payload.check.ts — the per-job grouping contract with Spark
    processObjectOperations,
    processArchivalObjectOperations,
    EmrPayload,
    EmrTriggerPayload,
};
