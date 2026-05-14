import * as fs from 'fs';

export interface JUnitCase {
    name: string;
    classname: string;
    timeSeconds: number;
    status: 'passed' | 'failed' | 'skipped';
    message?: string;
}

export interface JUnitSuite {
    name: string;
    tests: number;
    failures: number;
    skipped: number;
    timeSeconds: number;
    cases: JUnitCase[];
    architecture?: string;
    timedOut: boolean;
    systemErr?: string;
    systemOut?: string;
}

function decodeXmlEntities(text: string): string {
    return text
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(parseInt(code, 10)))
        .replace(/&amp;/g, '&');
}

function attr(tag: string, name: string): string | undefined {
    const m = tag.match(new RegExp(`${name}="([^"]*)"`));
    return m ? decodeXmlEntities(m[1]) : undefined;
}

function readCData(blockContent: string): string {
    const m = blockContent.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
    return m ? m[1] : decodeXmlEntities(blockContent.trim());
}

/**
 * Parses the JUnit-style XML written by Cosmos.TestRunner.Engine
 * (`OutputHandlerXml.cs`). Only one `<testsuite>` per file in practice.
 */
export function parseJUnitXml(xmlPath: string): JUnitSuite | undefined {
    let xml: string;
    try {
        xml = fs.readFileSync(xmlPath, 'utf8');
    } catch {
        return undefined;
    }

    const suiteMatch = xml.match(/<testsuite\b([^>]*)>([\s\S]*?)<\/testsuite>/);
    if (!suiteMatch) {
        return undefined;
    }

    const suiteAttrs = suiteMatch[1];
    const suiteBody = suiteMatch[2];

    const suite: JUnitSuite = {
        name: attr(suiteAttrs, 'name') ?? '',
        tests: parseInt(attr(suiteAttrs, 'tests') ?? '0', 10),
        failures: parseInt(attr(suiteAttrs, 'failures') ?? '0', 10),
        skipped: parseInt(attr(suiteAttrs, 'skipped') ?? '0', 10),
        timeSeconds: parseFloat(attr(suiteAttrs, 'time') ?? '0'),
        cases: [],
        timedOut: false
    };

    const propsMatch = suiteBody.match(/<properties>([\s\S]*?)<\/properties>/);
    if (propsMatch) {
        const propRegex = /<property\s+name="([^"]+)"\s+value="([^"]*)"/g;
        let pm: RegExpExecArray | null;
        while ((pm = propRegex.exec(propsMatch[1])) !== null) {
            if (pm[1] === 'architecture') {
                suite.architecture = pm[2];
            } else if (pm[1] === 'timedOut' && pm[2] === 'true') {
                suite.timedOut = true;
            }
        }
    }

    // Self-closing or with a body
    const caseRegex = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g;
    let cm: RegExpExecArray | null;
    while ((cm = caseRegex.exec(suiteBody)) !== null) {
        const caseAttrs = cm[1];
        const caseBody = cm[2] ?? '';

        const name = attr(caseAttrs, 'name') ?? '';
        const classname = attr(caseAttrs, 'classname') ?? '';
        const timeSeconds = parseFloat(attr(caseAttrs, 'time') ?? '0');

        let status: JUnitCase['status'] = 'passed';
        let message: string | undefined;

        const failureMatch = caseBody.match(/<failure\b([^>]*?)(?:\/>|>([\s\S]*?)<\/failure>)/);
        const skippedMatch = caseBody.match(/<skipped\b([^>]*?)(?:\/>|>([\s\S]*?)<\/skipped>)/);
        if (failureMatch) {
            status = 'failed';
            const inner = failureMatch[2] ? readCData(failureMatch[2]) : '';
            message = inner || attr(failureMatch[1], 'message') || 'Test failed';
        } else if (skippedMatch) {
            status = 'skipped';
            const inner = skippedMatch[2] ? readCData(skippedMatch[2]) : '';
            message = inner || attr(skippedMatch[1], 'message');
        }

        suite.cases.push({ name, classname, timeSeconds, status, message });
    }

    const errMatch = suiteBody.match(/<system-err>([\s\S]*?)<\/system-err>/);
    if (errMatch) {
        suite.systemErr = readCData(errMatch[1]);
    }
    const outMatch = suiteBody.match(/<system-out>([\s\S]*?)<\/system-out>/);
    if (outMatch) {
        suite.systemOut = readCData(outMatch[1]);
    }

    return suite;
}
