exports.up = function (knex) {
    return knex.schema.createTable("monitor_snooze", function (table) {
        table.integer("monitor_id").primary();
        table.datetime("until").notNullable();
        table.index("until");
    });
};

exports.down = function (knex) {
    return knex.schema.dropTable("monitor_snooze");
};
