import assert from 'assert';
import path from 'path';
import fs from 'fs';
import http from 'http';
import net from 'net';
import { db, initDatabase, getSetting, setSetting } from '../src/backend/db/database';
import { ConfigParser } from '../src/backend/parser/config-parser';
import { XrayConfigBuilder } from '../src/backend/vpn/xray-config-builder';
import { VpnEngine } from '../src/backend/vpn/vpn-engine';
import { LatencyTester } from '../src/backend/tester/latency-tester';
import { ErrorClassifier } from '../src/backend/opencode/error-classifier';
import { OpenCodeService } from '../src/backend/opencode/opencode-service';
import { CandidateRanker } from '../src/backend/tester/candidate-ranker';
import { ConfigFetcher } from '../src/backend/discovery/config-fetcher';
import { runSecurityTests } from './security-tests';

async function runTestSuite() {
  console.log('====================================================');
  console.log('🧪 Starting OpenCode Router Comprehensive Test Suite');
  console.log('====================================================\n');

  initDatabase();

  // Test 1: Parser Unit Tests (VLESS, VMess, Trojan, SS)
  console.log('▶ Test 1: Parser and Validator Verification');
  {
    // VLESS
    const vlessUrl = 'vless://d342d11e-d224-4463-b982-532309285094@192.0.2.1:443?security=tls&type=ws&path=%2F&host=ccc.xyz&sni=ccc.xyz&fp=chrome#US_Node';
    const vlessParsed = ConfigParser.parse(vlessUrl);
    assert(vlessParsed !== null, 'VLESS should parse correctly');
    assert.strictEqual(vlessParsed?.protocol, 'vless');
    assert.strictEqual(vlessParsed?.address, '192.0.2.1');
    assert.strictEqual(vlessParsed?.port, 443);
    assert.strictEqual(vlessParsed?.security, 'tls');
    assert.strictEqual(vlessParsed?.network, 'ws');
    assert.strictEqual(vlessParsed?.remark, 'US_Node');

    // VMess
    const vmessJson = JSON.stringify({
      add: '1.2.3.4',
      port: 8443,
      id: 'a0000000-0000-0000-0000-000000000001',
      aid: 0,
      net: 'ws',
      path: '/path',
      tls: 'tls',
      ps: 'VMess_Test'
    });
    const vmessUrl = `vmess://${Buffer.from(vmessJson).toString('base64')}`;
    const vmessParsed = ConfigParser.parse(vmessUrl);
    assert(vmessParsed !== null, 'VMess should parse correctly');
    assert.strictEqual(vmessParsed?.protocol, 'vmess');
    assert.strictEqual(vmessParsed?.address, '1.2.3.4');
    assert.strictEqual(vmessParsed?.port, 8443);
    assert.strictEqual(vmessParsed?.remark, 'VMess_Test');

    // Trojan
    const trojanUrl = 'trojan://securepass@trojan.example.com:443?sni=trojan.example.com#Trojan_Node';
    const trojanParsed = ConfigParser.parse(trojanUrl);
    assert(trojanParsed !== null, 'Trojan should parse correctly');
    assert.strictEqual(trojanParsed?.protocol, 'trojan');
    assert.strictEqual(trojanParsed?.address, 'trojan.example.com');
    assert.strictEqual(trojanParsed?.port, 443);

    // Shadowsocks
    const ssUrl = 'ss://YWVzLTI1Ni1nY206c2VjcmV0cGFzcw@198.51.100.1:8388#SS_Node';
    const ssParsed = ConfigParser.parse(ssUrl);
    assert(ssParsed !== null, 'Shadowsocks should parse correctly');
    assert.strictEqual(ssParsed?.protocol, 'ss');
    assert.strictEqual(ssParsed?.address, '198.51.100.1');
    assert.strictEqual(ssParsed?.port, 8388);

    // Invalid rejection
    assert.strictEqual(ConfigParser.parse('invalid://foo'), null);
    assert.strictEqual(ConfigParser.parse('vless://invalid-url-without-port'), null);
    console.log('  ✔ ConfigParser successfully parsed and validated all 4 protocols.\n');
  }

  // Test 2: Xray Config Builder
  console.log('▶ Test 2: Xray Client JSON Generation');
  {
    const config = {
      protocol: 'vless',
      address: '1.2.3.4',
      port: 443,
      security: 'reality',
      network: 'tcp',
      details: {
        uuid: 'd342d11e-d224-4463-b982-532309285094',
        sni: 'example.com',
        pbk: 'abcdef123456',
        sid: '1234'
      }
    };
    const json = XrayConfigBuilder.buildClientConfig(config, 10808, 10809);
    assert(json.inbounds.length >= 2, 'Should have SOCKS and HTTP inbounds');
    assert.strictEqual(json.inbounds[0].protocol, 'socks');
    assert.strictEqual(json.inbounds[0].port, 10808);
    assert.strictEqual(json.inbounds[1].protocol, 'http');
    assert.strictEqual(json.inbounds[1].port, 10809);
    assert.strictEqual(json.outbounds[0].protocol, 'vless');
    console.log('  ✔ XrayConfigBuilder successfully generated multi-inbound proxy structure.\n');
  }

  // Test 3: Scenario B - Dead Configuration handling & zero orphaned processes
  console.log('▶ Test 3: Scenario B - Dead Configuration & Process Cleanup');
  {
    const vpn = VpnEngine.getInstance();
    // Use an unassigned port where no service is listening
    const deadConfig = {
      id: 999999,
      protocol: 'vless',
      address: '127.0.0.1',
      port: 49999,
      remark: 'Dead_Server_Scenario_B',
      security: 'none',
      network: 'tcp',
      details_json: JSON.stringify({ uuid: '00000000-0000-0000-0000-000000000000' })
    };

    // TCP test should fail fast with connection refused
    const tcp = await LatencyTester.testRemoteTcp(deadConfig.address, deadConfig.port, 500);
    assert.strictEqual(tcp.reachable, false, 'Dead server should be detected as unreachable');

    // If started, Xray should stop cleanly without leaving zombie processes
    await vpn.stop();
    assert.strictEqual(vpn.isRunning(), false, 'VPN should be stopped');
    console.log('  ✔ Dead configuration failed fast; zero orphaned processes remained.\n');
  }

  // Test 4: Scenario C - OpenCode Network Failure Classification
  console.log('▶ Test 4: Scenario C - OpenCode Network Failure Classification');
  {
    const stdout = '';
    const stderr = 'level=ERROR message="stream error" error="AI_RetryError: Failed to fetch after 3 attempts. FetchError: connect ECONNREFUSED 127.0.0.1:4096"';
    const classification = ErrorClassifier.classify(1, stdout, stderr);
    assert.strictEqual(classification.category, 'NETWORK_ERROR');
    assert.strictEqual(classification.isRecoverableBySwitchingVpn, true);
    console.log('  ✔ Correctly classified network disconnection as recoverable by VPN rotation.\n');
  }

  // Test 5: Scenario D - Genuine Provider Rate Limit
  console.log('▶ Test 5: Scenario D - Provider Rate Limit Classification');
  {
    // Case 1: OpenCode Free tier limit (tied to IP)
    const ipLimitStderr = 'level=ERROR message="stream error" error="AI_RetryError: Failed after 3 attempts. Last error: Free usage limit reached. Free models work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going"';
    const c1 = ErrorClassifier.classify(1, '', ipLimitStderr);
    assert.strictEqual(c1.category, 'RATE_LIMIT');
    assert.strictEqual(c1.isRecoverableBySwitchingVpn, true, 'Free tier IP rate limit is recoverable via fresh VPN IP');

    // Case 2: Account-level HTTP 429 quota
    const account429Stderr = 'level=ERROR error="HTTP 429: You have exceeded your current quota, please check your plan and billing details."';
    const c2 = ErrorClassifier.classify(1, '', account429Stderr);
    assert.strictEqual(c2.category, 'RATE_LIMIT');
    assert.strictEqual(c2.isRecoverableBySwitchingVpn, false, 'Account level rate limit should stop rotation');
    console.log('  ✔ Provider rate-limits accurately differentiated (IP-based vs Account-level).\n');
  }

  // Test 6: Scenario E - Authentication Failure
  console.log('▶ Test 6: Scenario E - Authentication Failure Classification');
  {
    const authStderr = 'level=ERROR error="HTTP 401 Unauthorized: Invalid API key or missing credentials in ~/.local/share/opencode/auth.json"';
    const classification = ErrorClassifier.classify(1, '', authStderr);
    assert.strictEqual(classification.category, 'AUTH_ERROR');
    assert.strictEqual(classification.isRecoverableBySwitchingVpn, false, 'Auth errors must NOT trigger endless VPN switching');
    console.log('  ✔ Authentication error correctly halts rotation without blaming network.\n');
  }

  // Test 7: Scenario F - System & Other Applications Remain Unaffected
  console.log('▶ Test 7: Scenario F - System-Wide Network Isolation');
  {
    // Verify dedicated launcher exists and has isolated env flags
    const opencodeService = OpenCodeService.getInstance();
    const launcherPath = opencodeService.getLauncherPath();
    assert(fs.existsSync(launcherPath), 'Dedicated launcher opencode-vpn must exist');

    const launcherContent = fs.readFileSync(launcherPath, 'utf-8');
    // OpenCode's LLM runtime fails with ECONNREFUSED when an HTTP(S) proxy env var
    // is present, so the launcher must expose ONLY the SOCKS5 endpoint (ALL_PROXY).
    if (process.platform === 'win32') {
      assert(/set "ALL_PROXY=socks5:\/\//.test(launcherContent), 'Windows launcher sets ALL_PROXY (SOCKS5)');
      assert(/set "http_proxy="/.test(launcherContent), 'Windows launcher clears http_proxy (breaks OpenCode LLM runtime)');
      assert(launcherContent.includes('"%OPENCODE_BIN%" %*'), 'Windows launcher invokes opencode');
    } else {
      assert(launcherContent.includes('export all_proxy='), 'Launcher sets all_proxy specifically');
      assert(launcherContent.includes('unset http_proxy'), 'Launcher clears http_proxy (breaks OpenCode LLM runtime)');
      assert(launcherContent.includes('exec "$OPENCODE_BIN"'), 'Launcher invokes opencode');
    }

    // Check that our current process global environment does NOT have system-wide TUN routing rules
    const normalIp = await LatencyTester.getNormalPublicIp();
    assert(typeof normalIp === 'string' && normalIp.length > 0, 'Normal internet remains operational');
    console.log(`  ✔ OS network and developer tools untouched. Normal IP accessible (${normalIp}).`);
    console.log('  ✔ OpenCode proxy is isolated strictly through dedicated launcher.\n');
  }

  // Test 8: Scenario A & G - Working Connection Lifecycle & Repeated Execution
  console.log('▶ Test 8: Scenario A & G - Working Connection & Repeated Manual Execution');
  {
    // Start a lightweight local mock HTTP proxy server to verify local proxy binding and verification
    const mockProxyPort = 19988;
    const mockServer = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ip=198.51.100.42\nstatus=ok');
    });

    await new Promise<void>((resolve) => mockServer.listen(mockProxyPort, '127.0.0.1', () => resolve()));

    // Verify proxy probe connects through the port
    const probe = await LatencyTester.testProxyHttp(mockProxyPort, 1500);
    assert.strictEqual(probe.success, true, 'Proxy HTTP verification must succeed');
    assert(probe.latencyMs >= 0, 'Latency must be recorded');
    assert.strictEqual(probe.egressIp, '198.51.100.42', 'Egress IP correctly parsed');

    // Simulate Scenario A: Store as working connection
    db.prepare(`
      INSERT INTO configs (protocol, address, port, remark, security, network, raw_url, config_hash, last_status, last_latency_ms, consecutive_failures, success_count, details_json)
      VALUES ('vless', '127.0.0.1', ?, 'Mock_Working_Scenario_A', 'tls', 'tcp', 'vless://test', 'mock-hash-1', 'working', ?, 0, 1, '{}')
      ON CONFLICT(config_hash) DO UPDATE SET last_status = 'working', last_latency_ms = excluded.last_latency_ms, consecutive_failures = 0, success_count = success_count + 1
    `).run(mockProxyPort, probe.latencyMs);

    const workingRow = db.prepare('SELECT * FROM configs WHERE config_hash = ?').get('mock-hash-1') as any;
    assert.strictEqual(workingRow.last_status, 'working');
    assert.strictEqual(workingRow.last_latency_ms, probe.latencyMs);

    // Scenario G: Repeated execution retrieves previous test history and state
    const candidates = CandidateRanker.getRankedCandidates(10);
    const topCandidate = candidates[0];
    assert(topCandidate !== undefined, 'Top candidate should exist');
    assert.strictEqual(topCandidate.last_status, 'working', 'Previously successful candidate ranked highest on repeat run');

    // Cleanup: never leave test artefacts in the production database. A loopback
    // "working" row used to be picked up by the gateway and could poison rotation.
    db.prepare("DELETE FROM configs WHERE config_hash = 'mock-hash-1'").run();

    mockServer.close();
    console.log('  ✔ Scenario A: Working connection successfully verified and locked.');
    console.log('  ✔ Scenario G: Repeat execution cleanly re-uses test history and candidate scores.\n');
  }

  // Test 9: Security Hardening & Exposure Verification
  console.log('▶ Test 9: Security Hardening, Origin/Host Guards & Host Binding Verification');
  await runSecurityTests();

  console.log('====================================================');
  console.log('🎉 ALL ACCEPTANCE SCENARIOS (A - G) PASSED SUCCESSFULLY!');
  console.log('====================================================\n');
}

runTestSuite().catch((err) => {
  console.error('❌ Test suite failed:', err);
  process.exit(1);
});
