/*
 * ===========================================================================
 *  SQL QUERIES  —  THIS IS THE FILE YOU EDIT WHEN WIRING UP THE REAL DATABASE
 * ===========================================================================
 *
 * The app needs two queries per database engine:
 *
 *   1. SEARCH  — given a partial JTC number, return a short list of matches
 *                for the suggestions dropdown. Must return columns:
 *                   jtcNo, partName
 *
 *   2. GET_ONE — given one exact JTC number, return the full record for the
 *                label. Must return these columns (alias them to match!):
 *                   jtcNo, customer, partName, partNo, model, date, qty, uom, woNo
 *
 * Use the parameter placeholder style for your engine:
 *   - SQL Server (mssql): @jtc   (named parameter)
 *   - PostgreSQL (pg):    $1     (positional parameter)
 *
 * Replace `YOUR_TABLE` and the column names on the right-hand side of each
 * `AS alias` with the real ones from your schema. Keep the aliases (left side
 * of the app's expectations above) exactly as shown.
 */

// The job "model" — the SINGLE identifier that ties the DB value, locations.json
// `models`, auto-print routing, the wrong-model guard, and the JTC-suggestion filter
// together. Defined in ONE place; swap it with MODEL_MODE in .env — no edits scattered
// around the code. Presets are pre-built SQL expressions (never raw env text), so this
// can't be a SQL-injection vector. After changing the mode, set locations.json
// `models` to the matching values. `+ ISNULL(...)` concat (not CONCAT/STRING_SPLIT) so
// it works on this older SQL Server too. Default 'name' = SubProductGroup.Name (K2VG).
//   name       -> "K2VG"            (SubProductGroup.Name) [DEFAULT — group-level, unique,
//                                    and SHARED by a welding job and its painting parent]
//   code       -> "E23"             (SubProductGroup.Code; NOT unique — K0WY & K0WL both E21)
//   stock      -> "E23-0100"        (Product.PartNumber alone)
//   stock-name -> "E23-0100, K2VG"  (Product.PartNumber + Name) — PRODUCT-level, so a
//                                    welding job (…-WF) differs from its painting parent
//   code-name  -> "E23, K2VG"       (Code + Name)
const MODEL_EXPRS = {
  name: 'spg.Name',
  code: 'spg.Code',
  stock: 'p.PartNumber',
  'stock-name': "ISNULL(p.PartNumber,'') + ', ' + ISNULL(spg.Name,'')",
  'code-name': "ISNULL(spg.Code,'') + ', ' + ISNULL(spg.Name,'')",
};
const MODEL_EXPR =
  MODEL_EXPRS[String(process.env.MODEL_MODE || 'name').toLowerCase()] || MODEL_EXPRS.name;

module.exports = {
  // The model SQL expression, so adapters build the search filter on the SAME value.
  modelExpr: MODEL_EXPR,
  // SQL Server (Avelon-Yollink MES). Field -> source column:
  //   jtcNo     = Job.OrderNumber       customer    = Customer.Name
  //   partName  = Product.Name          partNo      = Product.PartNumber
  //   model     = MODEL_EXPR (default stock+name, see top)   date = Job.CreateDate
  //   qty       = Job.Quantity          barcodeId   = Job.Id
  //   empNo     = User.EmployeeNum (via Job.CreatedBy)
  //   stockCode / processCode = Flow (see the ⚠ ASSUMPTIONS on getOne below)
  //   coNo      = CustomerOrder.OrderNumber (C/O No) via
  //               Job.COItemId -> CustomerOrderItem -> CustomerOrder
  // coNo is LEFT JOINed, so make-to-stock jobs (no customer order) blank it.
  // jtcNo (Job.OrderNumber) and coNo are DISTINCT — the C/O No is never the JTC
  // No. NOTE: mapRecord carries jtcNo in the `woNumber` field key and coNo in
  // `coNumber` (that's how the MES template binds "JTC No" and "C/O No").
  // Tables are dbo.* — the pool connects to MSSQL_DATABASE.
  mssql: (() => {
    // Shared SELECT list + FROM/JOINs so getOne and getCompletedSince always
    // return the SAME columns — maintain the field mapping in ONE place.
    // Stock Code and Process Code come from the job's routing (Flow rows).
    //
    // ⚠ ASSUMPTIONS — verify against a known-good Work Order label, then adjust:
    //   stockCode   = the FG OUTPUT node's StockCode (FlowType = 2). If the label
    //                 should show the RAW MATERIAL stock code instead, change the
    //                 "f.FlowType = 2" in the stockCode subquery to "= 0".
    //   processCode = every process step (FlowType = 1) joined in flow order,
    //                 e.g. "CT, BD". If it should be one specific step, narrow
    //                 the processCode subquery's WHERE.
    // The routing is the job's ProductFlowRevId, or the product's default
    // revision when the job has none (fr OUTER APPLY).
    const COLS = `
        j.Id              AS jobId,
        j.ParentJob       AS parentJobId,
        j.ActualEndDate   AS actualEnd,
        j.OrderNumber     AS jtcNo,
        c.Name            AS customer,
        p.Name            AS partName,
        p.PartNumber      AS partNo,
        ${MODEL_EXPR}     AS model,
        -- Format the date in SQL (style 103 = dd/mm/yyyy) so it can't be shifted
        -- by JS timezone conversion. CreateDate is a tz-less wall-clock datetime;
        -- the driver would otherwise read it as UTC and a late-afternoon time
        -- would roll to the next day when rendered in local (+8) time.
        CONVERT(varchar(10), j.CreateDate, 103) AS date,
        j.Quantity        AS qty,
        co.OrderNumber    AS coNo,
        j.Id              AS barcodeId,
        u.EmployeeNum     AS empNo,
        (SELECT TOP 1 f.StockCode
           FROM dbo.Flow f
           WHERE f.FlowRevId = fr.FlowRevId AND f.FlowType = 2
           ORDER BY f.Id) AS stockCode,
        STUFF((SELECT ', ' + f.ProcessCodeName
                 FROM dbo.Flow f
                 WHERE f.FlowRevId = fr.FlowRevId AND f.FlowType = 1
                   AND NULLIF(LTRIM(RTRIM(f.ProcessCodeName)), '') IS NOT NULL
                 ORDER BY f.X, f.Id
                 FOR XML PATH(''), TYPE).value('.', 'nvarchar(max)'), 1, 2, '') AS processCode`;
    const FROM = `
      FROM dbo.Job j
      LEFT JOIN dbo.Customer         c   ON c.Id   = j.CustomerId
      LEFT JOIN dbo.Product          p   ON p.Id   = j.ProductId
      LEFT JOIN dbo.SubProductGroup  spg ON spg.Id = p.SubProductGroupId
      LEFT JOIN dbo.CustomerOrderItem coi ON coi.Id  = j.COItemId
      LEFT JOIN dbo.CustomerOrder     co  ON co.Id   = coi.CustomerOrderId
      LEFT JOIN dbo.[User]            u   ON u.Id    = j.CreatedBy
      OUTER APPLY (
        SELECT COALESCE(
          j.ProductFlowRevId,
          (SELECT TOP 1 x.Id FROM dbo.FlowRevision x
             WHERE x.ProductId = j.ProductId
             ORDER BY x.IsDefault DESC, x.Revision DESC)
        ) AS FlowRevId
      ) fr`;
    return {
      // Suggestions list. Matches a typed JTC No OR a scanned barcode (Job.Id),
      // so both surface results. GROUP BY OrderNumber dedupes when several jobs
      // share a JTC No; TOP 20 keeps the dropdown snappy. Newest job first.
      // Suggestions list. `modelClause` is an optional, already-parameterised
      // "AND UPPER(spg.Code) IN (@m0,@m1,…)" the adapter injects when the tab has
      // models — so a workcell surfaces only its own model(s). Built this way (not
      // STRING_SPLIT) to work on older SQL Server compatibility levels too. Empty
      // clause = no filter. The model params themselves are bound by the adapter.
      searchBase: (modelClause = '') => `
        SELECT TOP 20
          j.OrderNumber AS jtcNo,
          MAX(p.Name)   AS partName
        FROM dbo.Job j
        LEFT JOIN dbo.Product p ON p.Id = j.ProductId
        LEFT JOIN dbo.SubProductGroup spg ON spg.Id = p.SubProductGroupId
        WHERE (j.OrderNumber LIKE @jtc OR CAST(j.Id AS varchar(20)) LIKE @jtc)
          ${modelClause}
        GROUP BY j.OrderNumber
        ORDER BY MAX(j.Id) DESC
      `,
      // Full record for one job. @jtc may be the JTC No (OrderNumber) OR the
      // barcode id (Job.Id) — so scanning the printed label resolves the job too.
      // TRY_CONVERT keeps the Id match safe when @jtc isn't numeric. TOP 1 +
      // ORDER BY Id DESC picks the latest job if a JTC No is reused.
      getOne: `
        SELECT TOP 1 ${COLS}
        ${FROM}
        WHERE LTRIM(RTRIM(j.OrderNumber)) = LTRIM(RTRIM(@jtc))
           OR j.Id = TRY_CONVERT(int, @jtc)
        ORDER BY j.Id DESC
      `,
      // Auto-print watcher: every job that COMPLETED (ActualEndDate set) strictly
      // after the caller's watermark, oldest-first so the watermark advances
      // monotonically. TOP 200 bounds one poll; a backlog drains over ticks.
      //
      // parentJtcNo = the OrderNumber of this job's ParentJob. For a Welding Line
      // JTC (Leak Test, processCode L-T/LKT) that parent is its Painting Line JTC
      // — the label we actually print in the welding->painting flow (autoPrint.js).
      getCompletedSince: `
        SELECT TOP 200 ${COLS},
          parent.OrderNumber AS parentJtcNo
        ${FROM}
        LEFT JOIN dbo.Job parent ON parent.Id = j.ParentJob
        WHERE j.ActualEndDate IS NOT NULL
          AND j.ActualEndDate > @since
        ORDER BY j.ActualEndDate ASC, j.Id ASC
      `,
      // Seed the watermark on first run: the newest completion that ALREADY
      // exists, so the watcher only acts on jobs that finish AFTER it starts.
      latestCompletion: `SELECT MAX(j.ActualEndDate) AS m FROM dbo.Job j`,
    };
  })(),

  postgres: {
    // Suggestions list. Matches on the JTC No (ordernumber) OR the barcode id,
    // so both typing and scanning surface results. ::text keeps the barcode
    // comparison safe whatever that column's underlying type is.
    search: `
      SELECT
        j.ordernumber AS "jtcNo",
        p.name        AS "partName"
      FROM public.maps_job j
      LEFT JOIN public.maps_product p ON p.id = j.productid
      LEFT JOIN public.jtc_maps_jp jp ON jp."jtc_orderNumber" = j.ordernumber
      WHERE j.ordernumber ILIKE $1
         OR jp."jtc_barcodeId"::text ILIKE $1
      GROUP BY j.ordernumber, p.name
      ORDER BY MAX(j.actualenddate) DESC NULLS LAST
      LIMIT 100
    `,
    // Full record for one job. $1 may be either the JTC No (ordernumber) or the
    // barcode id — so scanning the printed label's barcode resolves the job too.
    // jtc_maps_jp is a snapshot/history table (many rows per order); the ORDER BY
    // + LIMIT 1 picks the LATEST snapshot so the label reflects current data
    // (not an arbitrary old one). It sorts only the matched order's rows, so it
    // stays fast.
    getOne: `
      SELECT
        c.name              AS "customer",
        p.name              AS "partName",
        p.partnumber        AS "partNo",
        jp."jtc_PartNumber" AS "model",
        j.actualenddate     AS "date",
        j.quantity          AS "qty",
        jp."jtc_WO"         AS "woNo",
        j.ordernumber       AS "jtcNo",
        jp."jtc_barcodeId"  AS "barcodeId"
      FROM public.maps_job j
      LEFT JOIN public.maps_customer c ON c.id = j.customerid
      LEFT JOIN public.maps_product  p ON p.id = j.productid
      LEFT JOIN public.jtc_maps_jp  jp ON jp."jtc_orderNumber" = j.ordernumber
      WHERE btrim(j.ordernumber) = btrim($1)
         OR jp."jtc_barcodeId"::text = btrim($1)
      ORDER BY jp."jtc_createdAt" DESC NULLS LAST, jp."jtc_id" DESC
      LIMIT 1
    `,
    // Auto-print watcher: jobs completed after $1 (the watermark), oldest-first.
    // DISTINCT ON collapses the jtc_maps_jp snapshot rows to the latest per job.
    getCompletedSince: `
      SELECT * FROM (
        SELECT DISTINCT ON (j.id)
          j.id                AS "jobId",
          j.actualenddate     AS "actualEnd",
          c.name              AS "customer",
          p.name              AS "partName",
          p.partnumber        AS "partNo",
          jp."jtc_PartNumber" AS "model",
          j.actualenddate     AS "date",
          j.quantity          AS "qty",
          jp."jtc_WO"         AS "woNo",
          j.ordernumber       AS "jtcNo",
          jp."jtc_barcodeId"  AS "barcodeId"
        FROM public.maps_job j
        LEFT JOIN public.maps_customer c ON c.id = j.customerid
        LEFT JOIN public.maps_product  p ON p.id = j.productid
        LEFT JOIN public.jtc_maps_jp  jp ON jp."jtc_orderNumber" = j.ordernumber
        WHERE j.actualenddate IS NOT NULL AND j.actualenddate > $1
        ORDER BY j.id, jp."jtc_createdAt" DESC NULLS LAST
      ) s
      ORDER BY s."actualEnd" ASC
      LIMIT 200
    `,
    latestCompletion: `SELECT MAX(actualenddate) AS m FROM public.maps_job`,
  },
};
