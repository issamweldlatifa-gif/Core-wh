-- TEMP STORAGE WORKER — "Agent de stockage temporaire" (reference workflow).
-- Idempotent on fresh and existing databases: the role is created once and
-- mirrors RECEIVING_WORKER's permission vocabulary; what separates the two
-- jobs is the STATION (ST-STG-01, department STAGING).
INSERT INTO "roles" ("id", "name", "description", "isSystem", "applicationClass", "createdAt", "updatedAt")
SELECT gen_random_uuid(),
       'TEMP_STORAGE_WORKER',
       'Temporary Storage agent: place CONFIRMED products into temporary containers by customer section (task: temporary-storage).',
       true,
       'OPERATIONAL',
       now(),
       now()
WHERE NOT EXISTS (SELECT 1 FROM "roles" WHERE "name" = 'TEMP_STORAGE_WORKER');

INSERT INTO "role_permissions" ("roleId", "permissionId", "grantedAt")
SELECT target.id, rp."permissionId", now()
FROM "roles" target
JOIN "roles" source ON source."name" = 'RECEIVING_WORKER'
JOIN "role_permissions" rp ON rp."roleId" = source.id
WHERE target."name" = 'TEMP_STORAGE_WORKER'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
