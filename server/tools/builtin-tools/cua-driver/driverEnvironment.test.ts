import { describe, expect, test } from 'bun:test';
import { cuaDriverProcessEnvironment, isInterpreterInternalEnvName } from './driverEnvironment';

describe('cuaDriverProcessEnvironment', () => {
  const hostEnv: NodeJS.ProcessEnv = {
    INTERPRETER_USER_DATA_DIR: '/home/user/.config/Interpreter',
    INTERPRETER_HOME: '/home/user/.interpreter',
    INTERPRETER_CLI_PATH: '/opt/interpreter/bin/interpreter-app',
    INTERPRETER_CLI_SERVER_CONNECTION: 'http://127.0.0.1:5177',
    INTERPRETER_CALLER_TOKEN: 'caller-binding',
    INTERPRETER_WORKSTATION_ACCESS: 'read-write',
    WORKSTATION_EXPLICIT_WORKSPACE: '/work',
    LOG_FILE: '/home/user/.config/Interpreter/logs/main.log',
    SENTRY_ENVIRONMENT: 'production',
    VITE_PORT: '5173',
    CODEX_HOME: '/home/user/.interpreter',
    QWEN_ASR_ASSET_DIR: '/assets/qwen',
    MOONSHINE_ASSET_DIR: '/assets/moonshine',
    PLAYWRITER_AUTO_ENABLE: '1',
    DISPLAY: ':0',
    WAYLAND_DISPLAY: 'wayland-0',
    XAUTHORITY: '/run/user/1000/.Xauthority',
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
    XDG_RUNTIME_DIR: '/run/user/1000',
    XDG_SESSION_TYPE: 'x11',
    HOME: '/home/user',
    PATH: '/usr/bin:/bin',
    LANG: 'en_US.UTF-8',
    CUA_DRIVER_PATH: '/opt/cua-driver',
    CUA_DRIVER_RS_ENABLE_WAYLAND: '1',
  };

  test('removes Interpreter internal variables', () => {
    const env = cuaDriverProcessEnvironment(hostEnv);
    for (const name of [
      'INTERPRETER_USER_DATA_DIR',
      'INTERPRETER_HOME',
      'INTERPRETER_CLI_PATH',
      'INTERPRETER_CLI_SERVER_CONNECTION',
      'INTERPRETER_CALLER_TOKEN',
      'INTERPRETER_WORKSTATION_ACCESS',
      'WORKSTATION_EXPLICIT_WORKSPACE',
      'LOG_FILE',
      'SENTRY_ENVIRONMENT',
      'VITE_PORT',
      'CODEX_HOME',
      'QWEN_ASR_ASSET_DIR',
      'MOONSHINE_ASSET_DIR',
      'PLAYWRITER_AUTO_ENABLE',
    ]) {
      expect(env).not.toHaveProperty(name);
    }
  });

  test('keeps desktop session, locale, path and driver variables', () => {
    const env = cuaDriverProcessEnvironment(hostEnv);
    expect(env).toEqual({
      DISPLAY: ':0',
      WAYLAND_DISPLAY: 'wayland-0',
      XAUTHORITY: '/run/user/1000/.Xauthority',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
      XDG_RUNTIME_DIR: '/run/user/1000',
      XDG_SESSION_TYPE: 'x11',
      HOME: '/home/user',
      PATH: '/usr/bin:/bin',
      LANG: 'en_US.UTF-8',
      CUA_DRIVER_PATH: '/opt/cua-driver',
      CUA_DRIVER_RS_ENABLE_WAYLAND: '1',
    });
  });

  test('does not mutate the input environment', () => {
    const input = { ...hostEnv };
    const result = cuaDriverProcessEnvironment(input);
    expect(input).toEqual(hostEnv);
    expect(result).not.toBe(input);
  });

  test('classifies names independently of case', () => {
    expect(isInterpreterInternalEnvName('interpreter_user_data_dir')).toBe(true);
    expect(isInterpreterInternalEnvName('Log_File')).toBe(true);
    expect(isInterpreterInternalEnvName('INTERPRETERX')).toBe(false);
    expect(isInterpreterInternalEnvName('XDG_DATA_HOME')).toBe(false);
  });
});
