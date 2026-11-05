package quartzadmin.testbed;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.zaxxer.hikari.HikariDataSource;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.sql.Statement;
import java.sql.Types;
import java.util.Date;
import java.util.Map;
import java.util.TreeMap;
import org.quartz.JobExecutionContext;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * 잡 실행 기록을 {@code TESTBED_EXECUTIONS} 테이블에 남긴다. 테스트는 이 테이블로 "실제로 발화했는지"를 확인한다.
 *
 * <p>잡이 시작할 때 행을 넣고({@code OUTCOME=RUNNING}), 끝날 때 {@code FINISHED_AT}과 결과를 채운다. 기록은 Quartz 트랜잭션과
 * 별개의 커넥션 풀로 바로 커밋한다.
 */
public final class ExecutionRecorder implements AutoCloseable {

  public static final String CONTEXT_KEY = "testbed.recorder";

  private static final Logger log = LoggerFactory.getLogger(ExecutionRecorder.class);
  private static final ObjectMapper JSON = new ObjectMapper();

  private final HikariDataSource dataSource;
  private final String table;
  private final String instanceId;

  ExecutionRecorder(HikariDataSource dataSource, String table, String instanceId) {
    this.dataSource = dataSource;
    this.table = table;
    this.instanceId = instanceId;
  }

  static ExecutionRecorder create(TestbedConfig cfg, String instanceId) throws SQLException {
    HikariDataSource ds =
        HikariConnectionProvider.create(
            cfg.jdbcUrl, cfg.dbUser, cfg.dbPassword, cfg.driverProperties, 4, "recorder");
    ExecutionRecorder recorder = new ExecutionRecorder(ds, cfg.executionsTable, instanceId);
    recorder.ensureTable();
    return recorder;
  }

  /** 테이블이 없으면 만든다. 두 노드가 동시에 만들려고 하면 한쪽은 실패하므로 다시 확인한다. */
  void ensureTable() throws SQLException {
    if (tableExists()) {
      return;
    }
    try (Connection c = dataSource.getConnection(); Statement s = c.createStatement()) {
      s.execute(createTableSql(c.getMetaData().getDatabaseProductName()));
      c.commit();
      log.info("{} 테이블을 만들었습니다", table);
    } catch (SQLException e) {
      if (!tableExists()) {
        throw e;
      }
    }
  }

  private boolean tableExists() throws SQLException {
    try (Connection c = dataSource.getConnection(); Statement s = c.createStatement()) {
      s.executeQuery("SELECT 1 FROM " + table + " WHERE 1 = 0").close();
      return true;
    } catch (SQLException e) {
      return false;
    }
  }

  String createTableSql(String productName) {
    boolean oracle = productName.toLowerCase().contains("oracle");
    String str = oracle ? "VARCHAR2" : "VARCHAR";
    String num = oracle ? "NUMBER(13)" : "BIGINT";
    String small = oracle ? "NUMBER(10)" : "INTEGER";
    return "CREATE TABLE "
        + table
        + " ("
        + "FIRE_INSTANCE_ID "
        + str
        + "(200) NOT NULL PRIMARY KEY, "
        + "SCHED_NAME "
        + str
        + "(120) NOT NULL, "
        + "INSTANCE_ID "
        + str
        + "(200) NOT NULL, "
        + "JOB_NAME "
        + str
        + "(200) NOT NULL, "
        + "JOB_GROUP "
        + str
        + "(200) NOT NULL, "
        + "JOB_CLASS "
        + str
        + "(250) NOT NULL, "
        + "TRIGGER_NAME "
        + str
        + "(200) NOT NULL, "
        + "TRIGGER_GROUP "
        + str
        + "(200) NOT NULL, "
        + "SCHEDULED_FIRE_TIME "
        + num
        + ", "
        + "FIRE_TIME "
        + num
        + " NOT NULL, "
        + "STARTED_AT "
        + num
        + " NOT NULL, "
        + "FINISHED_AT "
        + num
        + ", "
        + "OUTCOME "
        + str
        + "(16) NOT NULL, "
        + "RECOVERING "
        + str
        + "(1) NOT NULL, "
        + "REFIRE_COUNT "
        + small
        + " NOT NULL, "
        + "JOB_DATA "
        + str
        + "(4000))";
  }

  public void recordStart(JobExecutionContext ctx) {
    String sql =
        "INSERT INTO "
            + table
            + " (FIRE_INSTANCE_ID, SCHED_NAME, INSTANCE_ID, JOB_NAME, JOB_GROUP, JOB_CLASS,"
            + " TRIGGER_NAME, TRIGGER_GROUP, SCHEDULED_FIRE_TIME, FIRE_TIME, STARTED_AT, OUTCOME,"
            + " RECOVERING, REFIRE_COUNT, JOB_DATA)"
            + " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'RUNNING', ?, ?, ?)";
    try (Connection c = dataSource.getConnection(); PreparedStatement ps = c.prepareStatement(sql)) {
      int i = 1;
      ps.setString(i++, ctx.getFireInstanceId());
      ps.setString(i++, ctx.getScheduler().getSchedulerName());
      ps.setString(i++, instanceId);
      ps.setString(i++, ctx.getJobDetail().getKey().getName());
      ps.setString(i++, ctx.getJobDetail().getKey().getGroup());
      ps.setString(i++, ctx.getJobDetail().getJobClass().getSimpleName());
      ps.setString(i++, ctx.getTrigger().getKey().getName());
      ps.setString(i++, ctx.getTrigger().getKey().getGroup());
      setTime(ps, i++, ctx.getScheduledFireTime());
      setTime(ps, i++, ctx.getFireTime());
      ps.setLong(i++, System.currentTimeMillis());
      ps.setString(i++, ctx.isRecovering() ? "1" : "0");
      ps.setInt(i++, ctx.getRefireCount());
      ps.setString(i, jobData(ctx));
      ps.executeUpdate();
      c.commit();
    } catch (Exception e) {
      log.error("실행 시작 기록 실패: {}", ctx.getFireInstanceId(), e);
    }
  }

  public void recordFinish(JobExecutionContext ctx, String outcome) {
    String sql =
        "UPDATE " + table + " SET FINISHED_AT = ?, OUTCOME = ? WHERE FIRE_INSTANCE_ID = ?";
    try (Connection c = dataSource.getConnection(); PreparedStatement ps = c.prepareStatement(sql)) {
      ps.setLong(1, System.currentTimeMillis());
      ps.setString(2, outcome);
      ps.setString(3, ctx.getFireInstanceId());
      ps.executeUpdate();
      c.commit();
    } catch (Exception e) {
      log.error("실행 종료 기록 실패: {}", ctx.getFireInstanceId(), e);
    }
  }

  private static void setTime(PreparedStatement ps, int index, Date value) throws SQLException {
    if (value == null) {
      ps.setNull(index, Types.NUMERIC);
    } else {
      ps.setLong(index, value.getTime());
    }
  }

  /** 잡과 트리거의 JobDataMap을 합친 값(Quartz가 잡에 넘기는 값)을 JSON으로 남긴다. */
  static String jobData(JobExecutionContext ctx) throws JsonProcessingException {
    Map<String, Object> merged = new TreeMap<>();
    for (Map.Entry<String, Object> e : ctx.getMergedJobDataMap().entrySet()) {
      Object v = e.getValue();
      merged.put(
          e.getKey(),
          v instanceof String || v instanceof Number || v instanceof Boolean || v == null
              ? v
              : String.valueOf(v));
    }
    String json = JSON.writeValueAsString(merged);
    return json.length() > 4000 ? json.substring(0, 4000) : json;
  }

  @Override
  public void close() {
    dataSource.close();
  }
}
