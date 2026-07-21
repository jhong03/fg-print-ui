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
  mssql: {
    // Suggestions list. TOP 10 keeps the dropdown snappy.
    search: `
      SELECT TOP 10
        jtc_no    AS jtcNo,
        part_name AS partName
      FROM YOUR_TABLE
      WHERE jtc_no LIKE @jtc
      ORDER BY jtc_no
    `,
    // Full record for one JTC number.
    getOne: `
      SELECT
        jtc_no     AS jtcNo,
        customer   AS customer,
        part_name  AS partName,
        part_no    AS partNo,
        model      AS model,
        job_date   AS date,
        qty        AS qty,
        uom        AS uom,
        wo_no      AS woNo
      FROM YOUR_TABLE
      WHERE jtc_no = @jtc
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
