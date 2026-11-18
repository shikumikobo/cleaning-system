// 取り込む種類ごとの列（見出し・必須・別名・ひな形の例）。R-014-1・4
export type Kind = "clients" | "buildings" | "rooms" | "contracts";
export const KINDS: Kind[] = ["clients", "buildings", "rooms", "contracts"];

const LABEL: Record<Kind, string> = { clients: "取引先", buildings: "建物", rooms: "部屋", contracts: "契約" };
export const kindLabel = (k: Kind): string => LABEL[k];

export interface Column {
  /** 行の中での名前（plan の payload と同じ） */
  field: string;
  /** 見出し（ひな形の1行目） */
  label: string;
  required: boolean;
  /** 見出しの別名（全角半角・空白は無視して比べる） */
  aliases?: string[];
}

const COLUMNS: Record<Kind, Column[]> = {
  clients: [
    { field: "name", label: "名前", required: true, aliases: ["取引先名", "会社名", "名称"] },
    { field: "kind", label: "種類", required: false, aliases: ["取引先の種類"] },
    { field: "address", label: "住所", required: false },
    { field: "phone", label: "電話", required: false, aliases: ["電話番号", "tel"] },
    { field: "email", label: "メール", required: false, aliases: ["メールアドレス", "email"] },
    { field: "closing_day", label: "締め日", required: false, aliases: ["締日"] },
    { field: "payment_terms", label: "支払い条件", required: false, aliases: ["支払条件"] },
  ],
  buildings: [
    { field: "client_name", label: "取引先名", required: true, aliases: ["取引先", "依頼元"] },
    { field: "name", label: "建物名", required: true, aliases: ["建物"] },
    { field: "address", label: "住所", required: true },
    { field: "owner_name", label: "所有者名", required: false, aliases: ["所有者", "オーナー名", "オーナー"] },
  ],
  rooms: [
    { field: "client_name", label: "取引先名", required: true, aliases: ["取引先", "依頼元"] },
    { field: "building_name", label: "建物名", required: true, aliases: ["建物"] },
    { field: "room_no", label: "部屋番号", required: true, aliases: ["部屋"] },
    { field: "floor", label: "階", required: false, aliases: ["階数"] },
  ],
  contracts: [
    { field: "client_name", label: "取引先名", required: true, aliases: ["取引先", "依頼元"] },
    { field: "building_name", label: "建物名", required: true, aliases: ["建物"] },
    { field: "kind", label: "契約の種類", required: true, aliases: ["契約種類"] },
    { field: "start_date", label: "開始日", required: true, aliases: ["契約開始日"] },
    { field: "end_date", label: "終了日", required: false, aliases: ["契約終了日"] },
    { field: "service_name", label: "清掃の名前", required: true, aliases: ["清掃名", "サービス名"] },
    { field: "service_kind", label: "清掃の種類", required: true, aliases: ["サービスの種類"] },
    { field: "amount", label: "金額", required: true, aliases: ["料金", "月額"] },
    { field: "billing", label: "請求", required: false, aliases: ["請求の仕方"] },
    { field: "recurrence", label: "頻度", required: false, aliases: ["繰り返し"] },
    { field: "start_time", label: "開始時刻", required: false },
    { field: "end_time", label: "終了時刻", required: false },
  ],
};
export const columnsOf = (k: Kind): Column[] => COLUMNS[k];

/** ひな形の例の行（列の順）。取引先 → 建物 → 部屋 → 契約の順に取り込むと、誤りなく取り込める */
export const EXAMPLES: Record<Kind, string[][]> = {
  clients: [
    ["青空管理株式会社", "管理会社", "東京都千代田区1-1-1", "03-0000-0000", "info@example.com", "31", "月末締め翌月末払い"],
    ["山田オーナー", "オーナー", "東京都港区2-2-2", "", "", "25", ""],
  ],
  buildings: [
    ["青空管理株式会社", "ひまわりマンション", "東京都千代田区3-3-3", "山田オーナー"],
    ["青空管理株式会社", "さくらハイツ", "東京都千代田区4-4-4", ""],
  ],
  rooms: [
    ["青空管理株式会社", "ひまわりマンション", "101", "1"],
    ["青空管理株式会社", "ひまわりマンション", "102", "1"],
    ["青空管理株式会社", "ひまわりマンション", "201", "2"],
  ],
  contracts: [
    ["青空管理株式会社", "ひまわりマンション", "定期", "2027-01-01", "", "定期清掃", "基本", "30000", "毎月", "毎週月曜", "09:00", "12:00"],
    ["青空管理株式会社", "ひまわりマンション", "定期", "2027-01-01", "", "窓清掃", "オプション", "12000", "行った回ごと", "3か月に1回", "", ""],
    ["青空管理株式会社", "さくらハイツ", "単発", "2027-02-10", "2027-02-10", "特別清掃", "特別清掃", "50000", "", "単発", "", ""],
  ],
};

/** 入れ方の説明（画面に出す） */
export const HINTS: Record<Kind, string[]> = {
  clients: [
    "名前だけが必須です。種類は「管理会社」か「オーナー」（空なら管理会社）。締め日は 1〜31（31 または「月末」で月末）。",
    "同じ名前の取引先が登録済みなら、重なりとして飛ばします。",
  ],
  buildings: [
    "取引先名・建物名・住所が必須です。取引先は、先に取り込んで（登録して）おいてください。所有者名は、登録済みのオーナーの名前。",
    "同じ取引先の中で同じ名前の建物があれば、重なりとして飛ばします。",
  ],
  rooms: [
    "取引先名・建物名・部屋番号が必須です。建物は、先に取り込んで（登録して）おいてください。階は整数（1階・1F も可）。",
    "同じ建物の中で同じ部屋番号があれば、重なりとして飛ばします。",
  ],
  contracts: [
    "1行が清掃の中身1つです。取引先・建物・契約の種類・開始日・終了日が同じ行は、1つの契約にまとまります。",
    "契約の種類は「定期」「単発」、清掃の種類は「基本」「オプション」「特別清掃」、請求は「毎月」「行った回ごと」（空は、基本なら毎月・ほかは行った回ごと）。",
    "頻度は「毎週月曜」「隔週火曜」「毎月第2水曜」「毎月15日」「毎月末」「3か月に1回」「単発」か、RRULE（FREQ=WEEKLY;BYDAY=MO など）。空は単発です。",
    "取引先・建物は、先に取り込んで（登録して）おいてください。まとめた中の1行でも間違いがあれば、その契約は取り込みません。",
  ],
};
