// 共享：RFID 标签打印模板（PC + 移动复用）

export function PrintLabels({
  epc,
  name,
  price,
  category,
  count,
}: {
  epc: string;
  name: string;
  price: number;
  category: string;
  count: number;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(4, 1fr)",
        gap: "4mm",
        padding: "5mm",
      }}
    >
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          style={{
            border: "1px solid #000",
            borderRadius: "2mm",
            padding: "3mm",
            fontFamily: "sans-serif",
            color: "#000",
            background: "#fff",
            minHeight: "30mm",
          }}
        >
          <div style={{ fontSize: "9px", color: "#555" }}>{category}</div>
          <div style={{ fontSize: "13px", fontWeight: 700, margin: "1mm 0" }}>{name}</div>
          <div style={{ fontSize: "20px", fontWeight: 800 }}>¥{price.toFixed(2)}</div>
          <div style={{ fontFamily: "monospace", fontSize: "8px", marginTop: "1mm" }}>{epc}</div>
        </div>
      ))}
    </div>
  );
}

export const PRINT_STYLE = `
  @media print {
    body * { visibility: hidden; }
    .print-area, .print-area * { visibility: visible; }
    .print-area { position: absolute; top: 0; left: 0; width: 100%; display: block !important; }
    .print-area .hidden { display: block !important; }
  }
`;
