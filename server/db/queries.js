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

module.exports = {
  // SQL Server (Avelon-Yollink MES). Field -> source column:
  //   jtcNo     = Job.OrderNumber       customer    = Customer.Name
  //   partName  = Product.Name          partNo      = Product.PartNumber
  //   model     = SubProductGroup.Name  date        = Job.CreateDate
  //   qty       = Job.Quantity          barcodeId   = Job.Id
  //   empNo     = User.EmployeeNum (via Job.CreatedBy)
  //   stockCode / processCode = Flow (see the ⚠ ASSUMPTIONS on getOne below)
  // The "W/O No" label field is the JTC No itself (see mapRecord woNumber),
  // so there's no MO join. Tables are dbo.* — the pool connects to MSSQL_DATABASE.
  mssql: {
    // Suggestions list. Matches a typed JTC No OR a scanned barcode (Job.Id),
    // so both surface results. GROUP BY OrderNumber dedupes when several jobs
    // share a JTC No; TOP 10 keeps the dropdown snappy. Newest job first.
    search: `
      SELECT TOP 10
        j.OrderNumber AS jtcNo,
        MAX(p.Name)   AS partName
      FROM dbo.Job j
      LEFT JOIN dbo.Product p ON p.Id = j.ProductId
      WHERE j.OrderNumber LIKE @jtc
         OR CAST(j.Id AS varchar(20)) LIKE @jtc
      GROUP BY j.OrderNumber
      ORDER BY MAX(j.Id) DESC
    `,
    // Full record for one job. @jtc may be the JTC No (OrderNumber) OR the
    // barcode id (Job.Id) — so scanning the printed label resolves the job too.
    // TRY_CONVERT keeps the Id match safe when @jtc isn't numeric. TOP 1 +
    // ORDER BY Id DESC picks the latest job if a JTC No is reused.
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
    getOne: `
      SELECT TOP 1
        j.OrderNumber     AS jtcNo,
        c.Name            AS customer,
        p.Name            AS partName,
        p.PartNumber      AS partNo,
        spg.Name          AS model,
        j.CreateDate      AS date,
        j.Quantity        AS qty,
        mo.Field1         AS woNo,
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
                 FOR XML PATH(''), TYPE).value('.', 'nvarchar(max)'), 1, 2, '') AS processCode
      FROM dbo.Job j
      LEFT JOIN dbo.Customer         c   ON c.Id   = j.CustomerId
      LEFT JOIN dbo.Product          p   ON p.Id   = j.ProductId
      LEFT JOIN dbo.SubProductGroup  spg ON spg.Id = p.SubProductGroupId
      LEFT JOIN dbo.MO               mo  ON mo.Id  = j.MOId
      LEFT JOIN dbo.[User]           u   ON u.Id   = j.CreatedBy
      OUTER APPLY (
        SELECT COALESCE(
          j.ProductFlowRevId,
          (SELECT TOP 1 x.Id FROM dbo.FlowRevision x
             WHERE x.ProductId = j.ProductId
             ORDER BY x.IsDefault DESC, x.Revision DESC)
        ) AS FlowRevId
      ) fr
      WHERE LTRIM(RTRIM(j.OrderNumber)) = LTRIM(RTRIM(@jtc))
         OR j.Id = TRY_CONVERT(int, @jtc)
      ORDER BY j.Id DESC
    `,
  },

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
  },
};
