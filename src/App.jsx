import React, { useEffect, useMemo, useState } from "react";
import { onAuthStateChanged, signInWithPopup, signOut } from "firebase/auth";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  serverTimestamp,
  setDoc,
  deleteDoc,
} from "firebase/firestore";
import { auth, db, provider } from "./firebase";

const BUSINESS_TYPES = [
  "證券（傳統）",
  "證券（分戶帳）",
  "既有轉分戶帳",
  "期貨",
  "融資",
  "不限用途",
  "複委託",
  "債券+",
  "PGN",
  "ELN",
  "RP",
];

const DEFAULT_STAFF = [
  "廖淑惠",
  "廖秀芬",
  "劉大賢",
  "包峰吉",
  "陳郁婷",
  "許芬芳",
  "鄭裕蓁",
  "陳雅芬",
  "洪嘉貞",
  "林佳靜",
  "高瑜珮",
  "羅佳倫",
  "朱君白",
  "潘志鈞",
  "蔡明吟",
  "孔安萍",
  "金運宜",
];

const STAFF_META_DOC = "staff_list";
const APP_META_COLLECTION = "app_meta";
const DAILY_RECORDS_COLLECTION = "daily_records";
const USERS_COLLECTION = "users";

const getToday = () => new Date().toISOString().slice(0, 10);

function formatDate(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr + "T00:00:00");
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(
    2,
    "0"
  )}/${String(d.getDate()).padStart(2, "0")}`;
}

function getWeekStart(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d.toISOString().slice(0, 10);
}

function getWeekEnd(dateStr) {
  const d = new Date(getWeekStart(dateStr) + "T00:00:00");
  d.setDate(d.getDate() + 6);
  return d.toISOString().slice(0, 10);
}

function getMonthKey(dateStr) {
  return dateStr.slice(0, 7);
}

function getYearKey(dateStr) {
  return dateStr.slice(0, 4);
}

function createEmptyMatrix(staffList) {
  const matrix = {};
  staffList.forEach((staff) => {
    matrix[staff] = {};
    BUSINESS_TYPES.forEach((biz) => {
      matrix[staff][biz] = "";
    });
  });
  return matrix;
}

function ensureMatrixShape(matrix, staffList) {
  const base = createEmptyMatrix(staffList);
  staffList.forEach((staff) => {
    BUSINESS_TYPES.forEach((biz) => {
      base[staff][biz] = matrix?.[staff]?.[biz] ?? "";
    });
  });
  return base;
}

function safeNumber(v) {
  if (v === "" || v === null || v === undefined) return 0;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function matrixTotal(matrix) {
  return Object.values(matrix).reduce((sum, row) => {
    return (
      sum +
      Object.values(row || {}).reduce(
        (rowSum, cell) => rowSum + safeNumber(cell),
        0
      )
    );
  }, 0);
}

function matrixToRows(matrix, date) {
  const rows = [];
  Object.keys(matrix || {}).forEach((staff) => {
    BUSINESS_TYPES.forEach((biz) => {
      const qty = safeNumber(matrix?.[staff]?.[biz]);
      if (qty > 0) {
        rows.push({ date, staff, businessType: biz, qty });
      }
    });
  });
  return rows;
}

function buildGroupedRows(rows) {
  const grouped = {};
  rows.forEach((r) => {
    const key = `${r.date}__${r.staff}`;
    if (!grouped[key]) {
      grouped[key] = { date: r.date, staff: r.staff, values: {}, total: 0 };
      BUSINESS_TYPES.forEach((biz) => {
        grouped[key].values[biz] = 0;
      });
    }
    grouped[key].values[r.businessType] += safeNumber(r.qty);
    grouped[key].total += safeNumber(r.qty);
  });

  return Object.values(grouped).sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    return a.staff.localeCompare(b.staff);
  });
}

function downloadExcelLikeFile(filename, rows) {
  const csv = rows
    .map((row) =>
      row
        .map((cell) => {
          const v = String(cell ?? "");
          return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
        })
        .join(",")
    )
    .join("\n");

  const blob = new Blob(["\ufeff" + csv], {
    type: "application/vnd.ms-excel;charset=utf-8;",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function App() {
  const [firebaseReady, setFirebaseReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [user, setUser] = useState(null);
  const [userProfile, setUserProfile] = useState(null);
  const [authError, setAuthError] = useState("");

  const [staffOptions, setStaffOptions] = useState(DEFAULT_STAFF);
  const [date, setDate] = useState(getToday());
  const [matrix, setMatrix] = useState(createEmptyMatrix(DEFAULT_STAFF));
  const [allData, setAllData] = useState({});
  const [newStaffName, setNewStaffName] = useState("");
  const [reportType, setReportType] = useState("daily");
  const [reportDate, setReportDate] = useState(getToday());
  const [reportMonth, setReportMonth] = useState(getToday().slice(0, 7));
  const [reportYear, setReportYear] = useState(getToday().slice(0, 4));

  const role = userProfile?.role || "viewer";
  const canEdit = role === "admin" || role === "editor";
  const canManageStaff = role === "admin";

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (firebaseUser) => {
      setLoading(true);
      setAuthError("");

      if (!firebaseUser) {
        setUser(null);
        setUserProfile(null);
        setAllData({});
        setStaffOptions(DEFAULT_STAFF);
        setMatrix(createEmptyMatrix(DEFAULT_STAFF));
        setFirebaseReady(true);
        setLoading(false);
        return;
      }

      try {
        const email = (firebaseUser.email || "").toLowerCase();
        const userSnap = await getDoc(doc(db, USERS_COLLECTION, email));

        if (!userSnap.exists()) {
          setAuthError("此帳號尚未加入系統白名單，請先請管理員建立 users 權限資料。");
          await signOut(auth);
          setLoading(false);
          return;
        }

        const profile = userSnap.data();

        if (profile.active === false) {
          setAuthError("此帳號已停用。");
          await signOut(auth);
          setLoading(false);
          return;
        }

        const staffSnap = await getDoc(doc(db, APP_META_COLLECTION, STAFF_META_DOC));
        const dbStaff =
          staffSnap.exists() && Array.isArray(staffSnap.data()?.names)
            ? staffSnap.data().names
            : DEFAULT_STAFF;

        const recordsSnap = await getDocs(collection(db, DAILY_RECORDS_COLLECTION));
        const loadedData = {};
        recordsSnap.forEach((recordDoc) => {
          const payload = recordDoc.data();
          loadedData[recordDoc.id] = ensureMatrixShape(payload.data || {}, dbStaff);
        });

        setUser(firebaseUser);
        setUserProfile({ email, ...profile });
        setStaffOptions(dbStaff);
        setAllData(loadedData);
        setMatrix(ensureMatrixShape(loadedData[date] || {}, dbStaff));
      } catch (error) {
        console.error(error);
        setAuthError("讀取 Firebase 資料失敗，請稍後再試。");
      } finally {
        setFirebaseReady(true);
        setLoading(false);
      }
    });

    return () => unsub();
  }, [date]);

  useEffect(() => {
    setMatrix(ensureMatrixShape(allData[date] || {}, staffOptions));
  }, [date, allData, staffOptions]);

  const handleGoogleLogin = async () => {
    setAuthError("");
    try {
      provider.setCustomParameters({ prompt: "select_account" });
      await signInWithPopup(auth, provider);
    } catch (error) {
      console.error(error);
      setAuthError("Google 登入失敗，請重試。");
    }
  };

  const handleLogout = async () => {
    await signOut(auth);
  };

  const handleChange = (staff, biz, value) => {
    if (!canEdit) return;
    const clean = value === "" ? "" : String(Math.max(0, Number(value) || 0));
    setMatrix((prev) => ({
      ...prev,
      [staff]: {
        ...prev[staff],
        [biz]: clean,
      },
    }));
  };

  const handleSave = async () => {
    if (!canEdit) return;
    setSaving(true);

    try {
      const normalized = ensureMatrixShape(matrix, staffOptions);
      const hasAnyValue = Object.values(normalized).some((row) =>
        Object.values(row).some((cell) => safeNumber(cell) > 0)
      );

      if (!hasAnyValue) {
        await deleteDoc(doc(db, DAILY_RECORDS_COLLECTION, date)).catch(() => {});
        setAllData((prev) => {
          const next = { ...prev };
          delete next[date];
          return next;
        });
        alert("當日資料為空，已清除該日紀錄");
        setSaving(false);
        return;
      }

      await setDoc(doc(db, DAILY_RECORDS_COLLECTION, date), {
        date,
        data: normalized,
        updatedBy: user?.email || "",
        updatedAt: serverTimestamp(),
      });

      setAllData((prev) => ({
        ...prev,
        [date]: normalized,
      }));

      alert("已儲存，可多人同步更新");
    } catch (error) {
      console.error(error);
      alert("儲存失敗，請稍後再試");
    } finally {
      setSaving(false);
    }
  };

  const handleLoadDate = (targetDate) => {
    setDate(targetDate);
  };

  const saveStaffList = async (names) => {
    await setDoc(doc(db, APP_META_COLLECTION, STAFF_META_DOC), {
      names,
      updatedBy: user?.email || "",
      updatedAt: serverTimestamp(),
    });
  };

  const handleAddStaff = async () => {
    if (!canManageStaff) return;

    const name = newStaffName.trim();
    if (!name) return;

    if (staffOptions.includes(name)) {
      alert("此營業員已存在");
      return;
    }

    const nextStaff = [...staffOptions, name];

    try {
      await saveStaffList(nextStaff);

      setStaffOptions(nextStaff);
      setMatrix((prev) => ensureMatrixShape({ ...prev, [name]: {} }, nextStaff));
      setAllData((prev) => {
        const next = { ...prev };
        Object.keys(next).forEach((d) => {
          next[d] = ensureMatrixShape(next[d], nextStaff);
        });
        return next;
      });

      setNewStaffName("");
    } catch (error) {
      console.error(error);
      alert("新增營業員失敗");
    }
  };

  const handleRemoveStaff = async (name) => {
    if (!canManageStaff) return;

    if (!window.confirm(`確定要移除 ${name} 嗎？此操作只會移出名單，不會刪除歷史資料。`)) {
      return;
    }

    const nextStaff = staffOptions.filter((s) => s !== name);

    try {
      await saveStaffList(nextStaff);

      setStaffOptions(nextStaff);
      setMatrix((prev) => ensureMatrixShape(prev, nextStaff));
      setAllData((prev) => {
        const next = { ...prev };
        Object.keys(next).forEach((d) => {
          next[d] = ensureMatrixShape(next[d], nextStaff);
        });
        return next;
      });
    } catch (error) {
      console.error(error);
      alert("移除營業員失敗");
    }
  };

  const allRows = useMemo(() => {
    let rows = [];
    Object.keys(allData).forEach((d) => {
      rows = rows.concat(matrixToRows(allData[d], d));
    });
    return rows;
  }, [allData]);

  const reportRows = useMemo(() => {
    if (reportType === "daily") {
      return allRows.filter((r) => r.date === reportDate);
    }

    if (reportType === "weekly") {
      const start = getWeekStart(reportDate);
      const end = getWeekEnd(reportDate);
      return allRows.filter((r) => r.date >= start && r.date <= end);
    }

    if (reportType === "monthly") {
      return allRows.filter((r) => getMonthKey(r.date) === reportMonth);
    }

    return allRows.filter((r) => getYearKey(r.date) === reportYear);
  }, [allRows, reportType, reportDate, reportMonth, reportYear]);

  const groupedReportRows = useMemo(() => buildGroupedRows(reportRows), [reportRows]);

  const reportSummary = useMemo(() => {
    const byStaff = {};
    const byBiz = {};
    let total = 0;

    reportRows.forEach((r) => {
      total += safeNumber(r.qty);
      byStaff[r.staff] = (byStaff[r.staff] || 0) + safeNumber(r.qty);
      byBiz[r.businessType] = (byBiz[r.businessType] || 0) + safeNumber(r.qty);
    });

    return {
      total,
      byStaff: Object.entries(byStaff).sort((a, b) => b[1] - a[1]),
      byBiz: Object.entries(byBiz).sort((a, b) => b[1] - a[1]),
    };
  }, [reportRows]);

  const historyDates = useMemo(
    () => Object.keys(allData).sort((a, b) => b.localeCompare(a)),
    [allData]
  );

  const exportReport = () => {
    const title =
      reportType === "daily"
        ? `每日報表_${reportDate}`
        : reportType === "weekly"
        ? `週報表_${getWeekStart(reportDate)}_to_${getWeekEnd(reportDate)}`
        : reportType === "monthly"
        ? `月報表_${reportMonth}`
        : `年報表_${reportYear}`;

    const rows = [];
    rows.push([title]);
    rows.push([]);
    rows.push(["日期", "營業員", ...BUSINESS_TYPES, "合計"]);

    groupedReportRows.forEach((row) => {
      rows.push([
        row.date,
        row.staff,
        ...BUSINESS_TYPES.map((biz) => row.values[biz] || 0),
        row.total,
      ]);
    });

    rows.push([]);
    rows.push(["總開戶數", reportSummary.total]);
    rows.push([]);
    rows.push(["依營業員統計"]);
    rows.push(["營業員", "數量"]);
    reportSummary.byStaff.forEach(([name, qty]) => rows.push([name, qty]));
    rows.push([]);
    rows.push(["依業務別統計"]);
    rows.push(["業務別", "數量"]);
    reportSummary.byBiz.forEach(([name, qty]) => rows.push([name, qty]));

    downloadExcelLikeFile(`${title}.xls`, rows);
  };

  const currentDayTotal = matrixTotal(matrix);

  if (!firebaseReady || loading) {
    return (
      <div style={pageStyle}>
        <div style={cardStyle}>
          <div style={{ fontSize: 18, fontWeight: 700 }}>載入中...</div>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div style={pageStyle}>
        <div style={{ ...cardStyle, maxWidth: 520, margin: "80px auto" }}>
          <h1 style={{ marginTop: 0, marginBottom: 12, fontSize: 32 }}>開戶統計系統</h1>
          <p style={{ color: "#64748b", lineHeight: 1.8, marginBottom: 16 }}>
            請使用公司 Google 帳號登入。登入後系統會自動檢查 Firestore users 白名單與角色權限。
          </p>

          {authError ? (
            <div style={errorBoxStyle}>{authError}</div>
          ) : null}

          <button onClick={handleGoogleLogin} style={primaryButtonStyle}>
            使用 Google 登入
          </button>

          <div style={{ marginTop: 16, fontSize: 13, color: "#64748b" }}>
            提醒：你必須先在 Firestore 建立 users 集合，並新增你的 email 文件，否則會被擋下。
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={pageStyle}>
      <div style={containerStyle}>
        <div style={headerStyle}>
          <div>
            <h1 style={{ margin: 0, fontSize: 34 }}>開戶統計系統</h1>
            <div style={{ color: "#64748b", marginTop: 8, fontSize: 14 }}>
              已支援：Google 登入、白名單權限、多人同步、匯出 Excel、日／週／月／年報表、可回溯修改、彈性增減營業員
            </div>
          </div>

          <div style={userBoxStyle}>
            <div style={{ fontWeight: 700, fontSize: 15 }}>
              {userProfile?.name || user.displayName || user.email}
            </div>
            <div style={{ fontSize: 13, color: "#64748b", marginTop: 4 }}>
              {user.email}｜角色：{role}
            </div>
            <button onClick={handleLogout} style={{ ...secondaryButtonStyle, marginTop: 10 }}>
              登出
            </button>
          </div>
        </div>

        <div style={mainGridStyle}>
          <div>
            <div style={cardStyle}>
              <h2 style={sectionTitleStyle}>每日開戶數據輸入</h2>

              <div style={toolbarStyle}>
                <input
                  type="date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  style={inputStyle}
                />

                <button
                  onClick={handleSave}
                  style={{
                    ...primaryButtonStyle,
                    opacity: !canEdit || saving ? 0.6 : 1,
                    cursor: !canEdit || saving ? "not-allowed" : "pointer",
                  }}
                  disabled={!canEdit || saving}
                >
                  {saving ? "儲存中..." : "儲存當日資料"}
                </button>

                <div style={{ fontSize: 15, color: "#334155" }}>
                  當日合計：<b>{currentDayTotal}</b>
                </div>
              </div>

              <div style={tableWrapStyle}>
                <table style={tableStyle}>
                  <thead>
                    <tr>
                      <th style={tableHeadStyle}>營業員 / 日期</th>
                      {BUSINESS_TYPES.map((biz) => (
                        <th key={biz} style={tableHeadStyle}>
                          {biz}
                        </th>
                      ))}
                      <th style={tableHeadStyle}>合計</th>
                    </tr>
                  </thead>
                  <tbody>
                    {staffOptions.map((staff) => {
                      const rowTotal = BUSINESS_TYPES.reduce(
                        (sum, biz) => sum + safeNumber(matrix?.[staff]?.[biz]),
                        0
                      );

                      return (
                        <tr key={staff}>
                          <td style={nameCellStyle}>{staff}</td>
                          {BUSINESS_TYPES.map((biz) => (
                            <td key={biz} style={tableCellStyle}>
                              <input
                                type="number"
                                min="0"
                                value={matrix?.[staff]?.[biz] ?? ""}
                                onChange={(e) => handleChange(staff, biz, e.target.value)}
                                disabled={!canEdit}
                                style={{
                                  ...cellInputStyle,
                                  background: canEdit ? "#ffffff" : "#f8fafc",
                                  opacity: canEdit ? 1 : 0.75,
                                }}
                              />
                            </td>
                          ))}
                          <td style={totalCellStyle}>{rowTotal}</td>
                        </tr>
                      );
                    })}

                    <tr style={{ background: "#f8fafc" }}>
                      <td style={nameCellStyle}>欄位合計</td>
                      {BUSINESS_TYPES.map((biz) => (
                        <td key={biz} style={totalCellStyle}>
                          {staffOptions.reduce(
                            (sum, staff) => sum + safeNumber(matrix?.[staff]?.[biz]),
                            0
                          )}
                        </td>
                      ))}
                      <td style={totalCellStyle}>{currentDayTotal}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            <div style={{ ...cardStyle, marginTop: 18 }}>
              <h2 style={sectionTitleStyle}>報表中心</h2>

              <div style={toolbarStyle}>
                <button
                  onClick={() => setReportType("daily")}
                  style={reportType === "daily" ? activeTabButtonStyle : tabButtonStyle}
                >
                  日報表
                </button>

                <button
                  onClick={() => setReportType("weekly")}
                  style={reportType === "weekly" ? activeTabButtonStyle : tabButtonStyle}
                >
                  週報表
                </button>

                <button
                  onClick={() => setReportType("monthly")}
                  style={reportType === "monthly" ? activeTabButtonStyle : tabButtonStyle}
                >
                  月報表
                </button>

                <button
                  onClick={() => setReportType("yearly")}
                  style={reportType === "yearly" ? activeTabButtonStyle : tabButtonStyle}
                >
                  年報表
                </button>

                <button onClick={exportReport} style={successButtonStyle}>
                  匯出 Excel
                </button>
              </div>

              <div style={{ marginBottom: 14 }}>
                {(reportType === "daily" || reportType === "weekly") && (
                  <input
                    type="date"
                    value={reportDate}
                    onChange={(e) => setReportDate(e.target.value)}
                    style={inputStyle}
                  />
                )}

                {reportType === "monthly" && (
                  <input
                    type="month"
                    value={reportMonth}
                    onChange={(e) => setReportMonth(e.target.value)}
                    style={inputStyle}
                  />
                )}

                {reportType === "yearly" && (
                  <input
                    type="number"
                    value={reportYear}
                    onChange={(e) => setReportYear(e.target.value)}
                    style={{ ...inputStyle, width: 120 }}
                  />
                )}
              </div>

              <div style={{ marginBottom: 14, fontSize: 15 }}>
                總開戶數：<b>{reportSummary.total}</b>
              </div>

              <div style={tableWrapStyle}>
                <table style={tableStyle}>
                  <thead>
                    <tr>
                      <th style={lightHeadStyle}>日期</th>
                      <th style={lightHeadStyle}>營業員</th>
                      {BUSINESS_TYPES.map((biz) => (
                        <th key={biz} style={lightHeadStyle}>
                          {biz}
                        </th>
                      ))}
                      <th style={lightHeadStyle}>合計</th>
                    </tr>
                  </thead>
                  <tbody>
                    {groupedReportRows.length ? (
                      groupedReportRows.map((row, idx) => (
                        <tr key={`${row.date}_${row.staff}_${idx}`}>
                          <td style={tableCellStyle}>{row.date}</td>
                          <td style={nameCellStyle}>{row.staff}</td>
                          {BUSINESS_TYPES.map((biz) => (
                            <td key={biz} style={tableCellStyle}>
                              {row.values[biz] || 0}
                            </td>
                          ))}
                          <td style={totalCellStyle}>{row.total}</td>
                        </tr>
                      ))
                    ) : (
                      <tr>
                        <td
                          colSpan={BUSINESS_TYPES.length + 3}
                          style={{ ...tableCellStyle, padding: 18, textAlign: "center" }}
                        >
                          目前沒有資料
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              <div style={summaryGridStyle}>
                <div style={summaryCardStyle}>
                  <h3 style={summaryTitleStyle}>依營業員統計</h3>
                  <ul style={listStyle}>
                    {reportSummary.byStaff.map(([name, qty]) => (
                      <li key={name} style={listItemStyle}>
                        <span>{name}</span>
                        <b>{qty}</b>
                      </li>
                    ))}
                  </ul>
                </div>

                <div style={summaryCardStyle}>
                  <h3 style={summaryTitleStyle}>依業務別統計</h3>
                  <ul style={listStyle}>
                    {reportSummary.byBiz.map(([name, qty]) => (
                      <li key={name} style={listItemStyle}>
                        <span>{name}</span>
                        <b>{qty}</b>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          </div>

          <div>
            <div style={cardStyle}>
              <h2 style={sectionTitleStyle}>營業員維護</h2>

              <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
                <input
                  type="text"
                  placeholder="新增營業員姓名"
                  value={newStaffName}
                  onChange={(e) => setNewStaffName(e.target.value)}
                  style={{ ...inputStyle, flex: 1 }}
                  disabled={!canManageStaff}
                />
                <button
                  onClick={handleAddStaff}
                  style={{
                    ...primaryButtonStyle,
                    opacity: canManageStaff ? 1 : 0.6,
                    cursor: canManageStaff ? "pointer" : "not-allowed",
                  }}
                  disabled={!canManageStaff}
                >
                  新增
                </button>
              </div>

              <div style={{ maxHeight: 360, overflowY: "auto" }}>
                {staffOptions.map((staff) => (
                  <div key={staff} style={staffRowStyle}>
                    <span>{staff}</span>
                    <button
                      onClick={() => handleRemoveStaff(staff)}
                      style={{
                        ...dangerButtonStyle,
                        opacity: canManageStaff ? 1 : 0.6,
                        cursor: canManageStaff ? "pointer" : "not-allowed",
                      }}
                      disabled={!canManageStaff}
                    >
                      移除
                    </button>
                  </div>
                ))}
              </div>

              {!canManageStaff && (
                <div style={{ marginTop: 12, fontSize: 13, color: "#64748b" }}>
                  只有 admin 可以維護營業員名單。
                </div>
              )}
            </div>

            <div style={{ ...cardStyle, marginTop: 18 }}>
              <h2 style={sectionTitleStyle}>歷史日期回溯修改</h2>

              <div style={{ color: "#64748b", marginBottom: 12, lineHeight: 1.7 }}>
                直接選日期載入。選到已有資料的日期時，左邊矩陣會自動帶回，修改後再按儲存即可。
              </div>

              <div style={toolbarStyle}>
                <input
                  type="date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  style={inputStyle}
                />
                <button onClick={() => handleLoadDate(date)} style={secondaryButtonStyle}>
                  載入該日資料
                </button>
              </div>

              <div style={{ fontSize: 14, color: "#334155", lineHeight: 1.9 }}>
                <div>
                  目前編輯日期：<b>{formatDate(date)}</b>
                </div>
                <div>
                  已儲存歷史筆數：<b>{historyDates.length}</b> 天
                </div>
                <div>
                  最早日期：
                  <b>
                    {historyDates.length
                      ? formatDate(historyDates[historyDates.length - 1])
                      : "—"}
                  </b>
                </div>
                <div>
                  最近日期：
                  <b>{historyDates.length ? formatDate(historyDates[0]) : "—"}</b>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const pageStyle = {
  minHeight: "100vh",
  background: "#f8fafc",
  color: "#0f172a",
  padding: 24,
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans TC", Arial, sans-serif',
};

const containerStyle = {
  maxWidth: 1600,
  margin: "0 auto",
};

const headerStyle = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: 20,
  marginBottom: 20,
};

const userBoxStyle = {
  background: "#ffffff",
  border: "1px solid #e2e8f0",
  borderRadius: 12,
  padding: 14,
  minWidth: 290,
  boxShadow: "0 4px 14px rgba(15, 23, 42, 0.05)",
};

const mainGridStyle = {
  display: "grid",
  gridTemplateColumns: "3fr 1.2fr",
  gap: 20,
};

const cardStyle = {
  background: "#ffffff",
  border: "1px solid #e2e8f0",
  borderRadius: 14,
  padding: 16,
  boxShadow: "0 6px 18px rgba(15, 23, 42, 0.05)",
};

const sectionTitleStyle = {
  marginTop: 0,
  marginBottom: 14,
  fontSize: 24,
};

const toolbarStyle = {
  display: "flex",
  gap: 8,
  alignItems: "center",
  flexWrap: "wrap",
  marginBottom: 12,
};

const inputStyle = {
  border: "1px solid #cbd5e1",
  borderRadius: 8,
  padding: "9px 12px",
  background: "#ffffff",
  fontSize: 14,
  color: "#0f172a",
};

const tableWrapStyle = {
  overflowX: "auto",
  border: "1px solid #e2e8f0",
  borderRadius: 12,
};

const tableStyle = {
  width: "100%",
  borderCollapse: "collapse",
  minWidth: 1200,
  background: "#ffffff",
};

const tableHeadStyle = {
  border: "1px solid #dbe3ee",
  padding: 10,
  textAlign: "center",
  whiteSpace: "nowrap",
  background: "#2563eb",
  color: "#ffffff",
  fontWeight: 700,
};

const lightHeadStyle = {
  border: "1px solid #dbe3ee",
  padding: 10,
  textAlign: "center",
  whiteSpace: "nowrap",
  background: "#f1f5f9",
  color: "#0f172a",
  fontWeight: 700,
};

const tableCellStyle = {
  border: "1px solid #e2e8f0",
  padding: 8,
  textAlign: "center",
};

const nameCellStyle = {
  border: "1px solid #e2e8f0",
  padding: 10,
  whiteSpace: "nowrap",
  fontWeight: 700,
  background: "#f8fafc",
  textAlign: "center",
};

const totalCellStyle = {
  border: "1px solid #e2e8f0",
  padding: 10,
  textAlign: "center",
  fontWeight: 700,
  background: "#f8fafc",
};

const cellInputStyle = {
  width: 68,
  border: "1px solid #cbd5e1",
  borderRadius: 8,
  padding: "6px 8px",
  textAlign: "center",
  fontSize: 14,
};

const summaryGridStyle = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: 16,
  marginTop: 16,
};

const summaryCardStyle = {
  border: "1px solid #e2e8f0",
  borderRadius: 12,
  padding: 14,
  background: "#ffffff",
};

const summaryTitleStyle = {
  marginTop: 0,
  marginBottom: 12,
  fontSize: 18,
};

const listStyle = {
  listStyle: "none",
  padding: 0,
  margin: 0,
};

const listItemStyle = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  padding: "8px 0",
  borderBottom: "1px solid #f1f5f9",
};

const staffRowStyle = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: 12,
  padding: "10px 0",
  borderBottom: "1px solid #f1f5f9",
};

const errorBoxStyle = {
  marginBottom: 12,
  color: "#b91c1c",
  background: "#fef2f2",
  border: "1px solid #fecaca",
  padding: 12,
  borderRadius: 10,
};

const baseButtonStyle = {
  padding: "10px 14px",
  borderRadius: 8,
  border: "1px solid #cbd5e1",
  cursor: "pointer",
  fontWeight: 700,
  fontSize: 14,
  boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
  transition: "all 0.15s ease",
  background: "#ffffff",
};

const primaryButtonStyle = {
  ...baseButtonStyle,
  background: "#2563eb",
  color: "#ffffff",
  border: "1px solid #2563eb",
};

const secondaryButtonStyle = {
  ...baseButtonStyle,
  background: "#ffffff",
  color: "#0f172a",
  border: "1px solid #94a3b8",
};

const successButtonStyle = {
  ...baseButtonStyle,
  background: "#0f766e",
  color: "#ffffff",
  border: "1px solid #0f766e",
};

const dangerButtonStyle = {
  ...baseButtonStyle,
  background: "#ffffff",
  color: "#b91c1c",
  border: "1px solid #fca5a5",
};

const tabButtonStyle = {
  ...baseButtonStyle,
  background: "#ffffff",
  color: "#334155",
  border: "1px solid #cbd5e1",
};

const activeTabButtonStyle = {
  ...baseButtonStyle,
  background: "#0f172a",
  color: "#ffffff",
  border: "1px solid #0f172a",
};