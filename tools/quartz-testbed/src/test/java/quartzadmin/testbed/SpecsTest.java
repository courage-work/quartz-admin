package quartzadmin.testbed;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.quartz.CronTrigger;
import org.quartz.JobDetail;
import org.quartz.JobKey;
import org.quartz.SimpleTrigger;
import org.quartz.Trigger;
import org.quartz.impl.matchers.GroupMatcher;
import org.quartz.impl.matchers.StringMatcher;
import quartzadmin.testbed.jobs.NonConcurrentSleepJob;

class SpecsTest {

  private static final ObjectMapper JSON = new ObjectMapper();

  private static JsonNode json(String s) throws Exception {
    return JSON.readTree(s);
  }

  @Test
  void 잡_명세를_JobDetail로_바꾼다() throws Exception {
    JobDetail job =
        Specs.job(
            json(
                """
                {"name":"j1","group":"g","type":"NonConcurrentSleepJob","durable":true,
                 "data":{"sleepSeconds":3,"label":"x","flag":true}}
                """));
    assertEquals(new JobKey("j1", "g"), job.getKey());
    assertEquals(NonConcurrentSleepJob.class, job.getJobClass());
    assertTrue(job.isDurable());
    assertEquals(3L, job.getJobDataMap().get("sleepSeconds"));
    assertEquals("x", job.getJobDataMap().get("label"));
  }

  @Test
  void 그룹이_없으면_DEFAULT를_쓴다() throws Exception {
    assertEquals("DEFAULT", Specs.jobKey(json("{\"name\":\"a\"}")).getGroup());
  }

  @Test
  void 알_수_없는_잡_종류는_거부한다() {
    assertThrows(
        Specs.BadRequest.class, () -> Specs.job(json("{\"name\":\"a\",\"type\":\"Nope\"}")));
  }

  @Test
  void SIMPLE_트리거_명세() throws Exception {
    Trigger t =
        Specs.trigger(
            json(
                """
                {"name":"t1","group":"g","type":"simple","intervalMs":1000,"startAt":1000,
                 "priority":7,"misfire":"MISFIRE_INSTRUCTION_FIRE_NOW","forJob":{"name":"j1","group":"g"}}
                """));
    SimpleTrigger s = assertInstanceOf(SimpleTrigger.class, t);
    assertEquals(1000L, s.getRepeatInterval());
    assertEquals(SimpleTrigger.REPEAT_INDEFINITELY, s.getRepeatCount());
    assertEquals(1000L, s.getStartTime().getTime());
    assertEquals(7, s.getPriority());
    assertEquals(SimpleTrigger.MISFIRE_INSTRUCTION_FIRE_NOW, s.getMisfireInstruction());
    assertEquals(new JobKey("j1", "g"), s.getJobKey());
  }

  @Test
  void 반복_없는_SIMPLE_트리거는_한_번만_실행한다() throws Exception {
    SimpleTrigger s =
        assertInstanceOf(SimpleTrigger.class, Specs.trigger(json("{\"name\":\"once\"}")));
    assertEquals(0, s.getRepeatCount());
  }

  @Test
  void CRON_트리거_명세() throws Exception {
    Trigger t =
        Specs.trigger(
            json(
                """
                {"name":"c1","type":"cron","cron":"0/5 * * * * ?","timeZone":"Asia/Seoul",
                 "misfire":"DO_NOTHING"}
                """));
    CronTrigger c = assertInstanceOf(CronTrigger.class, t);
    assertEquals("0/5 * * * * ?", c.getCronExpression());
    assertEquals("Asia/Seoul", c.getTimeZone().getID());
    assertEquals(CronTrigger.MISFIRE_INSTRUCTION_DO_NOTHING, c.getMisfireInstruction());
  }

  @Test
  void 트리거_종류에_맞지_않는_misfire는_거부한다() {
    assertThrows(
        Specs.BadRequest.class,
        () ->
            Specs.trigger(
                json("{\"name\":\"c\",\"type\":\"cron\",\"cron\":\"* * * * * ?\",\"misfire\":\"FIRE_NOW\"}")));
  }

  @Test
  void 잘못된_cron은_거부한다() {
    assertThrows(
        Specs.BadRequest.class,
        () -> Specs.trigger(json("{\"name\":\"c\",\"type\":\"cron\",\"cron\":\"bad\"}")));
  }

  @Test
  void 그룹_매처() throws Exception {
    GroupMatcher<JobKey> m = Specs.groupMatcher(json("{\"group\":\"rep\",\"operator\":\"starts_with\"}"));
    assertEquals("rep", m.getCompareToValue());
    assertEquals(StringMatcher.StringOperatorName.STARTS_WITH, m.getCompareWithOperator());
    assertEquals(
        StringMatcher.StringOperatorName.EQUALS,
        Specs.<JobKey>groupMatcher(json("{\"group\":\"g\"}")).getCompareWithOperator());
  }
}
