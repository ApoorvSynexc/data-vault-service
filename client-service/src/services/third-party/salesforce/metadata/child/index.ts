import { logger } from "../../../../../middlewares";
import { IUser } from "../../../../../models";
import { uploadToS3 } from "../../../s3-bucket";
import { ISalesforceChildRelationship } from "..";
import {
    buildS3Key,
    diffEntities,
    getComparisonContext,
    getStoredEntries,
    ISalesforceMetadataHandler,
    ISchemaComparison,
    IStoredEntry,
} from "../common";

export interface IChildChange {
    childSObject: string;
    field: string;
    changedKeys: string[];
    before: ISalesforceChildRelationship;
    after: ISalesforceChildRelationship;
}

export interface IChildDiff {
    childsChanged: boolean;
    addedChilds: string[];
    removedChilds: string[];
    modifiedChilds: IChildChange[];
}

export type IStoredChildEntry = IStoredEntry<ISalesforceChildRelationship[]>;

export interface IChildComparisonResult extends IChildDiff {
    latestChilds: ISalesforceChildRelationship[];
    storedEntries: IStoredChildEntry[];
}

// childSObject alone isn't always unique — a parent can have more than one
// relationship to the same child object type (e.g. two lookups to Contact) —
// so the field (the FK field name on the child) disambiguates.
const childKey = (child: ISalesforceChildRelationship): string => `${child.childSObject}:${child.field}`;

// Child-by-child, object-level diff of two relationship-tree snapshots — see
// diffEntities in ../common for the shared, order-independent, non-stringify comparison.
export const diffChilds = (
    existing: ISalesforceChildRelationship[],
    latest: ISalesforceChildRelationship[]
): IChildDiff => {
    const { changed, added, removed, modified } = diffEntities(existing, latest, childKey);
    return {
        childsChanged: changed,
        addedChilds: added,
        removedChilds: removed,
        modifiedChilds: modified.map(({ changedKeys, before, after }) => ({
            childSObject: after.childSObject,
            field: after.field,
            changedKeys,
            before,
            after,
        })),
    };
};

// `children` is the orchestrator's already-fetched describe snapshot — no live
// Salesforce call happens in this module any more. Legacy Apex `ISalesforceChild`
// carried a derived relationshipType (MASTER/LOOKUP/REQUIRED_LOOKUP) + isRequired
// that describe's own childRelationships entry doesn't expose directly (that
// classification lives on the *child* object's own field describe, not the
// parent's) — dropped rather than reconstructed via extra per-child-object
// describe calls, matching backup-service's own migrated shape. No consumer of
// this module's stored output depends on those two fields.
export const childComparison = async (
    params: ISchemaComparison,
    children: ISalesforceChildRelationship[]
): Promise<IChildComparisonResult> => {
    const { destConfig } = params;
    const key = buildS3Key({ ...params, metadataType: "childs" });

    const storedEntries = await getStoredEntries<ISalesforceChildRelationship[]>(destConfig, key);
    const storedChilds = storedEntries.length ? storedEntries[storedEntries.length - 1].context : [];
    const diff = diffChilds(storedChilds, children);

    return { ...diff, latestChilds: children, storedEntries };
};

export const childHandler = async (
    params: ISalesforceMetadataHandler,
    children: ISalesforceChildRelationship[],
    knownUser?: IUser
) => {
    const { backupConfigId, backupJobId, objectName } = params;
    try {
        const { destConfig } = await getComparisonContext(backupConfigId, knownUser);
        const diff = await childComparison({ ...params, destConfig }, children);
        if (diff.childsChanged) {
            const operations: Array<"inserts" | "updates" | "deletes"> = [];
            if (diff.addedChilds.length) {
                operations.push("inserts");
            }
            if (diff.modifiedChilds.length) {
                operations.push("updates");
            }
            if (diff.removedChilds.length) {
                operations.push("deletes");
            }
            const newEntry: IStoredChildEntry = {
                date: new Date().toISOString(),
                backupJobId,
                operations,
                sourceType: params.isInitialBackup ? "main" : "changes",
                context: diff.latestChilds,
            };
            const updatedEntries = [...diff.storedEntries, newEntry];
            const buffer = Buffer.from(JSON.stringify(updatedEntries, null, 2));
            const s3Key = buildS3Key({
                ...params,
                metadataType: 'childs',
            });

            await uploadToS3(destConfig, s3Key, buffer);

            logger.info(
                `Object child relationship change detected, backupConfigId=${backupConfigId}, backupJobId=${backupJobId}, objectName=${objectName}, added=${diff.addedChilds.length}, removed=${diff.removedChilds.length}, modified=${diff.modifiedChilds.length}`
            );
        }

        logger.info(
            `Object child comparison complete, backupConfigId=${backupConfigId}, backupJobId=${backupJobId}, objectName=${objectName}, childsChanged=${diff.childsChanged}`
        );

        return diff;
    } catch (error: any) {
        logger.error(
            `Object child comparison failed, backupConfigId=${backupConfigId}, backupJobId=${backupJobId}, objectName=${objectName}, errorMsg=${error?.message ?? error}`
        );
        throw error;
    }
}
