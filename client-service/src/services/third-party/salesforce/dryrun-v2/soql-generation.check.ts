// Run: npx ts-node src/services/third-party/salesforce/dryrun-v2/soql-generation.check.ts
//
// Regression coverage for the "raw parser leak" bug class: a SOQL top-level
// clause (LIMIT, USING SCOPE, WITH SYSTEM_MODE, ...) must be caught by
// assertNoTopLevelClauses with a clean message BEFORE it ever reaches the
// real SOQL parser in validate-soql.ts — see that file's own comment on
// RAW_PARSER_LEAK_RE for why an unlisted clause always surfaces as a
// confusing "Mismatched parentheses..."/"Expected identifier..." error
// instead. backup-service's archival-v2/index.ts keeps a byte-for-byte copy
// of this same regex/function that must be updated in step with this one.
import assert from 'assert';
import { assertNoTopLevelClauses } from './soql-generation';

const rejects = (condition: string, expectedClause: string): void => {
  assert.throws(
    () => assertNoTopLevelClauses(condition),
    (error: any) => {
      const message = error?.message ?? '';
      assert.ok(
        message.includes(`cannot contain ${expectedClause}`),
        `expected a clean "cannot contain ${expectedClause}" message for ${JSON.stringify(condition)}, got: ${message}`
      );
      return true;
    }
  );
};

const allows = (condition: string): void => {
  assert.doesNotThrow(() => assertNoTopLevelClauses(condition));
};

// The four clauses the original bug report named — already fixed (Sep 17
// commit), asserted here so a future edit can't silently regress them.
rejects("Status__c = 'Active' USING SCOPE mine", 'USING SCOPE');
rejects("Status__c = 'Active' WITH SYSTEM_MODE", 'SYSTEM_MODE');
rejects("Status__c = 'Active' WITH USER_MODE", 'USER_MODE');
rejects("Status__c = 'Active' FOR VIEW", 'FOR VIEW');
rejects("Status__c = 'Active' FOR REFERENCE", 'FOR REFERENCE');
rejects("Status__c = 'Active' GROUP BY Status__c", 'GROUP BY');
rejects("Status__c = 'Active' HAVING COUNT(Id) > 1", 'HAVING');

// The four clauses this fix newly closes.
rejects("Status__c = 'Active' FOR UPDATE", 'FOR UPDATE');
rejects("Status__c = 'Active' UPDATE TRACKING", 'UPDATE TRACKING');
rejects("Status__c = 'Active' UPDATE VIEWSTAT", 'UPDATE VIEWSTAT');
rejects("Status__c = 'Active' WITH SECURITY_ENFORCED", 'SECURITY_ENFORCED');

// A value that merely CONTAINS one of these words as a string-literal
// substring must not false-positive — the function strips quoted literals
// before scanning for exactly this reason.
allows("Notes__c LIKE '%offset%'");
allows("Name = 'For View Account'");
allows("Name = 'A Group By Any Other Name'");

// An ordinary, fully-supported condition is untouched.
allows("Status__c = 'Active' AND Amount > 100");

console.log('soql-generation.check: OK');
