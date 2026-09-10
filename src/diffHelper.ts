/**
 * Diff & Merge Engine for Save-Je
 * Zero-dependency line-by-line diffing and smart merging.
 */

export interface DiffLine {
  type: "equal" | "added" | "deleted";
  text: string;
}

export interface SideBySideRow {
  leftLineNum?: number;
  leftText?: string;
  leftType: "equal" | "deleted" | "empty";
  rightLineNum?: number;
  rightText?: string;
  rightType: "equal" | "added" | "empty";
}

/**
 * Computes Longest Common Subsequence line diff between textA and textB.
 */
export function computeLineDiff(textA: string, textB: string): DiffLine[] {
  const linesA = textA.split(/\r?\n/);
  const linesB = textB.split(/\r?\n/);

  const m = linesA.length;
  const n = linesB.length;

  // Boundary check for very large files to avoid memory exhaustion
  if (m * n > 4000000) {
    // Fallback simple line diff for extremely huge files (>2000 lines each)
    return fallbackDiff(linesA, linesB);
  }

  // Build DP table
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array(n + 1).fill(0)
  );

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (linesA[i - 1] === linesB[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to build diff
  const diff: DiffLine[] = [];
  let i = m;
  let j = n;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && linesA[i - 1] === linesB[j - 1]) {
      diff.unshift({ type: "equal", text: linesA[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      diff.unshift({ type: "added", text: linesB[j - 1] });
      j--;
    } else if (i > 0 && (j === 0 || dp[i][j - 1] < dp[i - 1][j])) {
      diff.unshift({ type: "deleted", text: linesA[i - 1] });
      i--;
    }
  }

  return diff;
}

function fallbackDiff(linesA: string[], linesB: string[]): DiffLine[] {
  const result: DiffLine[] = [];
  const max = Math.max(linesA.length, linesB.length);
  for (let i = 0; i < max; i++) {
    const a = linesA[i];
    const b = linesB[i];
    if (a !== undefined && b !== undefined) {
      if (a === b) {
        result.push({ type: "equal", text: a });
      } else {
        result.push({ type: "deleted", text: a });
        result.push({ type: "added", text: b });
      }
    } else if (a !== undefined) {
      result.push({ type: "deleted", text: a });
    } else if (b !== undefined) {
      result.push({ type: "added", text: b });
    }
  }
  return result;
}

/**
 * Transforms diff lines into side-by-side rows for visual display.
 */
export function buildSideBySideRows(diff: DiffLine[]): SideBySideRow[] {
  const rows: SideBySideRow[] = [];
  let leftNum = 1;
  let rightNum = 1;

  let i = 0;
  while (i < diff.length) {
    const item = diff[i];

    if (item.type === "equal") {
      rows.push({
        leftLineNum: leftNum++,
        leftText: item.text,
        leftType: "equal",
        rightLineNum: rightNum++,
        rightText: item.text,
        rightType: "equal",
      });
      i++;
    } else {
      // Gather contiguous deleted and added chunks
      const deletedChunk: string[] = [];
      const addedChunk: string[] = [];

      while (i < diff.length && diff[i].type !== "equal") {
        if (diff[i].type === "deleted") {
          deletedChunk.push(diff[i].text);
        } else if (diff[i].type === "added") {
          addedChunk.push(diff[i].text);
        }
        i++;
      }

      const maxLen = Math.max(deletedChunk.length, addedChunk.length);
      for (let k = 0; k < maxLen; k++) {
        const delText = deletedChunk[k];
        const addText = addedChunk[k];

        rows.push({
          leftLineNum: delText !== undefined ? leftNum++ : undefined,
          leftText: delText !== undefined ? delText : "",
          leftType: delText !== undefined ? "deleted" : "empty",
          rightLineNum: addText !== undefined ? rightNum++ : undefined,
          rightText: addText !== undefined ? addText : "",
          rightType: addText !== undefined ? "added" : "empty",
        });
      }
    }
  }

  return rows;
}

/**
 * Smart merge algorithm:
 * - Retains common lines.
 * - Combines additions from both sides cleanly.
 * - For differing blocks, includes content from both with clear clean separation.
 */
export function smartMerge(localText: string, remoteText: string): string {
  const diff = computeLineDiff(localText, remoteText);
  const mergedLines: string[] = [];

  let i = 0;
  while (i < diff.length) {
    const item = diff[i];

    if (item.type === "equal") {
      mergedLines.push(item.text);
      i++;
    } else {
      const localEdits: string[] = [];
      const remoteEdits: string[] = [];

      while (i < diff.length && diff[i].type !== "equal") {
        if (diff[i].type === "deleted") {
          localEdits.push(diff[i].text);
        } else if (diff[i].type === "added") {
          remoteEdits.push(diff[i].text);
        }
        i++;
      }

      // If local only had additions
      if (localEdits.length > 0 && remoteEdits.length === 0) {
        mergedLines.push(...localEdits);
      }
      // If remote only had additions
      else if (remoteEdits.length > 0 && localEdits.length === 0) {
        mergedLines.push(...remoteEdits);
      }
      // Both modified this section: combine both seamlessly
      else {
        // If one is empty lines and the other has content, prefer content
        const nonBlankLocal = localEdits.filter((l) => l.trim().length > 0);
        const nonBlankRemote = remoteEdits.filter((l) => l.trim().length > 0);

        if (nonBlankLocal.length > 0 && nonBlankRemote.length === 0) {
          mergedLines.push(...localEdits);
        } else if (nonBlankRemote.length > 0 && nonBlankLocal.length === 0) {
          mergedLines.push(...remoteEdits);
        } else {
          // Both have meaningful edits: include both sections without git markers
          mergedLines.push(...localEdits);
          // Only add separation if not duplicate
          const localSet = new Set(localEdits);
          const uniqueRemote = remoteEdits.filter((line) => !localSet.has(line));
          if (uniqueRemote.length > 0) {
            mergedLines.push(...uniqueRemote);
          }
        }
      }
    }
  }

  return mergedLines.join("\n");
}
