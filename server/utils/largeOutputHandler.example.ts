/**
 * Example and test file for large output handler
 * Run with: npx tsx server/utils/largeOutputHandler.example.ts
 */

import { handleLargeOutput } from './largeOutputHandler';
import { initializeSandbox, cleanupSandbox } from './sandboxManager';
import * as fs from 'fs/promises';

// Test 1: Small output (should pass through unchanged)
async function testSmallOutput() {
  console.log('\n=== Test 1: Small Output ===');

  const smallResult = {
    content: [{
      type: 'text',
      text: 'This is a small output that fits comfortably'
    }],
    isError: false
  };

  const result = await handleLargeOutput('test_small', smallResult);

  console.log('Input size:', smallResult.content[0].text?.length);
  console.log('Output equals input:', JSON.stringify(result) === JSON.stringify(smallResult));
  console.log('Result:', result.content[0].text);
}

// Test 2: Large output (should be written to file)
async function testLargeOutput() {
  console.log('\n=== Test 2: Large Output (>10,000 characters) ===');

  const largeText = 'x'.repeat(15000); // 15,000 characters
  const largeResult = {
    content: [{
      type: 'text',
      text: largeText
    }],
    isError: false
  };

  const result = await handleLargeOutput('test_large', largeResult);

  console.log('Input size:', largeText.length, 'characters');
  console.log('Output contains file path:', result.content[0].text!.includes('interpreter-sandbox'));
  console.log('Message is concise:', result.content[0].text!.split('\n').length <= 3);
  console.log('\nResult message:\n', result.content[0].text);

  // Extract and verify file
  const match = result.content[0].text!.match(/Output file: (.+)/);
  if (match) {
    const filePath = match[1];
    console.log('\nFile created at:', filePath);

    try {
      const fileContent = await fs.readFile(filePath, 'utf-8');
      console.log('File size:', fileContent.length, 'characters');
      console.log('Content matches:', fileContent === largeText);

      console.log('File will be cleaned up by sandbox manager');
    } catch (error) {
      console.error('Error reading/cleaning file:', error);
    }
  }
}

// Test 3: Multiple content items
async function testMultipleContentItems() {
  console.log('\n=== Test 3: Multiple Content Items ===');

  const result1 = {
    content: [
      {
        type: 'text',
        text: 'a'.repeat(6000)
      },
      {
        type: 'text',
        text: 'b'.repeat(6000)
      }
    ],
    isError: false
  };

  const result = await handleLargeOutput('test_multiple', result1);

  console.log('Total input size:', 12000, 'characters (6000 + 6000)');
  console.log('Output contains file path:', result.content[0].text!.includes('interpreter-sandbox'));

  // Extract and verify file
  const match = result.content[0].text!.match(/Output file: (.+)/);
  if (match) {
    const filePath = match[1];
    const fileContent = await fs.readFile(filePath, 'utf-8');
    console.log('File contains first part:', fileContent.includes('a'.repeat(6000)));
    console.log('File contains second part:', fileContent.includes('b'.repeat(6000)));
  }
}

// Test 4: Error flag preservation
async function testErrorFlag() {
  console.log('\n=== Test 4: Error Flag Preservation ===');

  const errorResult = {
    content: [{
      type: 'text',
      text: 'x'.repeat(15000)
    }],
    isError: true
  };

  const result = await handleLargeOutput('test_error', errorResult);

  console.log('isError preserved:', result.isError === true);
}

// Test 5: Real-world scenario - simulating a tool that lists many messages
async function testRealWorldScenario() {
  console.log('\n=== Test 5: Real-World Scenario (Email List) ===');

  // Simulate a large email list response
  const messages = [];
  for (let i = 0; i < 500; i++) {
    messages.push({
      id: `msg_${i}`,
      subject: `Email Subject ${i} - Lorem ipsum dolor sit amet`,
      from: `user${i}@example.com`,
      date: new Date().toISOString(),
      snippet: 'This is a preview of the email content that goes on for a while and contains various details...'
    });
  }

  const emailListResult = {
    content: [{
      type: 'text',
      text: JSON.stringify({ count: messages.length, messages }, null, 2)
    }],
    isError: false
  };

  const inputSize = emailListResult.content[0].text!.length;
  console.log('Simulated email list size:', inputSize.toLocaleString(), 'characters');

  const result = await handleLargeOutput('list_messages', emailListResult);

  if (inputSize > 10000) {
    console.log('Large output handled correctly');
    console.log('Message to agent:');
    console.log(result.content[0].text);
  } else {
    console.log('Output small enough to pass through directly');
  }
}

// Run all tests
async function runTests() {
  console.log('╔════════════════════════════════════════════════╗');
  console.log('║  Large Output Handler - Example & Test Suite  ║');
  console.log('╚════════════════════════════════════════════════╝');

  try {
    // Initialize sandbox before tests
    console.log('\n[Setup] Initializing sandbox...');
    await initializeSandbox();

    await testSmallOutput();
    await testLargeOutput();
    await testMultipleContentItems();
    await testErrorFlag();
    await testRealWorldScenario();

    console.log('\n✅ All tests completed successfully!');

    // Cleanup sandbox after tests
    console.log('\n[Teardown] Cleaning up sandbox...');
    await cleanupSandbox();
  } catch (error) {
    console.error('\n❌ Test failed:', error);
    process.exit(1);
  }
}

// Run if executed directly (ESM only)
// @ts-ignore - import.meta requires ESM module mode
if (typeof import.meta !== 'undefined' && import.meta.url === `file://${process.argv[1]}`) {
  runTests().catch(console.error);
}
