package quartzadmin.testbed;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import java.util.Map;
import java.util.Properties;
import org.junit.jupiter.api.Test;

class TestbedConfigTest {

  private static final Map<String, String> BASE =
      Map.of(
          "TESTBED_DB_URL", "jdbc:oracle:thin:@//oracle:1521/FREEPDB1",
          "TESTBED_DB_USER", "quartz",
          "TESTBED_DB_PASSWORD", "secret");

  @Test
  void 환경변수로_클러스터_설정을_만든다() {
    Map<String, String> env = new java.util.HashMap<>(BASE);
    env.put("TESTBED_SCHEDULER_NAME", "S1");
    env.put("TESTBED_INSTANCE_ID", "node-1");
    env.put("TESTBED_TABLE_PREFIX", "APP_");
    env.put("TESTBED_QUARTZ_PROPERTIES", "org.quartz.jobStore.acquireTriggersWithinLock=true");
    Properties p = TestbedConfig.fromEnv(env).toQuartzProperties();
    assertEquals("S1", p.getProperty("org.quartz.scheduler.instanceName"));
    assertEquals("node-1", p.getProperty("org.quartz.scheduler.instanceId"));
    assertEquals("APP_", p.getProperty("org.quartz.jobStore.tablePrefix"));
    assertEquals("true", p.getProperty("org.quartz.jobStore.isClustered"));
    assertEquals(
        "org.quartz.impl.jdbcjobstore.oracle.OracleDelegate",
        p.getProperty("org.quartz.jobStore.driverDelegateClass"));
    assertEquals("8", p.getProperty("org.quartz.dataSource.testbed.maxConnections"));
    assertEquals("true", p.getProperty("org.quartz.jobStore.acquireTriggersWithinLock"));
  }

  @Test
  void 접속_정보가_없으면_실패한다() {
    assertThrows(IllegalArgumentException.class, () -> TestbedConfig.fromEnv(Map.of()));
  }

  @Test
  void 실행_기록_테이블_이름은_식별자만_허용한다() {
    Map<String, String> env = new java.util.HashMap<>(BASE);
    env.put("TESTBED_EXECUTIONS_TABLE", "X; DROP TABLE Y");
    assertThrows(IllegalArgumentException.class, () -> TestbedConfig.fromEnv(env));
  }

  @Test
  void DB_종류별_기본_delegate() {
    assertEquals(
        "org.quartz.impl.jdbcjobstore.PostgreSQLDelegate",
        TestbedConfig.defaultDelegate("jdbc:postgresql://db/quartz"));
    assertEquals(
        "org.quartz.impl.jdbcjobstore.StdJDBCDelegate",
        TestbedConfig.defaultDelegate("jdbc:mysql://db/quartz"));
  }

  @Test
  void Oracle은_불리언을_네이티브로_보내지_않는_것이_기본이다() {
    assertEquals(
        "false",
        TestbedConfig.fromEnv(BASE).driverProperties.getProperty(
            "oracle.jdbc.sendBooleanAsNativeBoolean"));
    Map<String, String> env = new java.util.HashMap<>(BASE);
    env.put("TESTBED_DB_PROPERTIES", "oracle.jdbc.sendBooleanAsNativeBoolean=true");
    TestbedConfig cfg = TestbedConfig.fromEnv(env);
    assertEquals("true", cfg.driverProperties.getProperty("oracle.jdbc.sendBooleanAsNativeBoolean"));
    assertEquals(
        "oracle.jdbc.sendBooleanAsNativeBoolean=true\n",
        cfg.toQuartzProperties().getProperty("org.quartz.dataSource.testbed.driverProperties"));
  }

  @Test
  void Oracle이_아니면_드라이버_속성을_넣지_않는다() {
    Map<String, String> env = new java.util.HashMap<>(BASE);
    env.put("TESTBED_DB_URL", "jdbc:postgresql://db/quartz");
    assertEquals(0, TestbedConfig.fromEnv(env).driverProperties.size());
  }
}
