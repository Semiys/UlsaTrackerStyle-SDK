SELECT *
FROM (
    SELECT
        dimension.1 AS kind,
        dimension.2 AS label,
        dimension.3 AS screen,
        count() AS count,
        uniqExactIf(session_id, dimension.1 = 'totals') AS sessions,
        countIf(dimension.1 = 'totals' AND name = 'screen_view') AS screenViews,
        countIf(dimension.1 = 'totals' AND name = 'button_click') AS buttonClicks,
        countIf(dimension.1 = 'totals' AND name = 'action_success') AS successfulActions,
        row_number() OVER (
            PARTITION BY dimension.1
            ORDER BY count() DESC, dimension.2 ASC NULLS LAST, dimension.3 ASC NULLS LAST
        ) AS position
    FROM (
        SELECT name, screen AS event_screen, session_id, occurred_at, properties
        FROM events FINAL
        WHERE project_id = {project:String}
          AND occurred_at >= parseDateTime64BestEffort({from:String}, 3, 'UTC')
          AND occurred_at < parseDateTime64BestEffort({until:String}, 3, 'UTC')
    )
    ARRAY JOIN arrayConcat(
        [
            tuple('totals', CAST(NULL AS Nullable(String)), CAST(NULL AS Nullable(String))),
            tuple('byName', toNullable(toString(name)), CAST(NULL AS Nullable(String))),
            tuple('daily', toNullable(toString(toDate(occurred_at, 'UTC'))), CAST(NULL AS Nullable(String)))
        ],
        if(event_screen IS NOT NULL,
            [tuple('byScreen', event_screen, CAST(NULL AS Nullable(String)))], []),
        if(name = 'screen_view',
            [tuple('byScreenViews', event_screen, CAST(NULL AS Nullable(String)))], []),
        if(name = 'button_click',
            [tuple('byButton',
                if(JSONType(properties, 'button') = 'String',
                    nullIf(trimBoth(JSONExtractString(properties, 'button')), ''), NULL),
                event_screen)], []),
        if(name = 'action_success',
            [tuple('byAction',
                if(JSONType(properties, 'action') = 'String',
                    nullIf(trimBoth(JSONExtractString(properties, 'action')), ''), NULL),
                event_screen)], [])
    ) AS dimension
    GROUP BY dimension
)
WHERE kind IN ('totals', 'daily') OR position <= 101
ORDER BY kind, position
