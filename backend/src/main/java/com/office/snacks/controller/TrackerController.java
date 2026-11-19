package com.office.snacks.controller;

import com.office.snacks.dto.ApiDtos.*;
import com.office.snacks.dto.TotalRow;
import com.office.snacks.service.SnackTrackerService;
import jakarta.validation.Valid;
import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.web.bind.annotation.*;
import java.time.LocalDate;
import java.util.*;
import org.springframework.security.core.Authentication;
import org.springframework.beans.factory.annotation.Value;

@RestController @RequestMapping("/api")
public class TrackerController {
 private final SnackTrackerService service;
 private final long employeeProfileId;
 public TrackerController(SnackTrackerService service,@Value("${app.employee-id}") long employeeProfileId){this.service=service;this.employeeProfileId=employeeProfileId;}
 @GetMapping("/employees") public List<EntityResponse> employees(){return service.employees();}
 @GetMapping("/me") public EntityResponse me(Authentication auth){if(auth.getAuthorities().stream().anyMatch(a->a.getAuthority().equals("ROLE_ADMIN")))throw new org.springframework.web.server.ResponseStatusException(org.springframework.http.HttpStatus.NOT_FOUND,"Employee profile not applicable");return service.employee(employeeProfileId);}
 @GetMapping("/employees/{id}") public EntityResponse employee(@PathVariable Long id){return service.employees().stream().filter(x->x.id().equals(id)).findFirst().orElseThrow(()->new org.springframework.web.server.ResponseStatusException(org.springframework.http.HttpStatus.NOT_FOUND,"Employee not found"));}
 @PostMapping("/employees") public EntityResponse createEmployee(@Valid @RequestBody EntityRequest request){return service.saveEmployee(null,request);}
 @PutMapping("/employees/{id}") public EntityResponse updateEmployee(@PathVariable Long id,@Valid @RequestBody EntityRequest request){return service.saveEmployee(id,request);}
 @DeleteMapping("/employees/{id}") public DeleteResponse deleteEmployee(@PathVariable Long id){return service.deleteEmployee(id);}
 @GetMapping("/snacks") public List<EntityResponse> snacks(){return service.snacks();}
 @GetMapping("/snacks/{id}") public EntityResponse snack(@PathVariable Long id){return service.snacks().stream().filter(x->x.id().equals(id)).findFirst().orElseThrow(()->new org.springframework.web.server.ResponseStatusException(org.springframework.http.HttpStatus.NOT_FOUND,"Snack not found"));}
 @PostMapping("/snacks") public EntityResponse createSnack(@Valid @RequestBody EntityRequest request){return service.saveSnack(null,request);}
 @PutMapping("/snacks/{id}") public EntityResponse updateSnack(@PathVariable Long id,@Valid @RequestBody EntityRequest request){return service.saveSnack(id,request);}
 @DeleteMapping("/snacks/{id}") public DeleteResponse deleteSnack(@PathVariable Long id){return service.deleteSnack(id);}
 @PostMapping("/records") public RecordResponse createRecord(@Valid @RequestBody RecordRequest request,Authentication auth){if(auth.getAuthorities().stream().noneMatch(a->a.getAuthority().equals("ROLE_ADMIN")))request=new RecordRequest(employeeProfileId,request.snackId(),request.quantity());return service.addRecord(request);}
 @PostMapping("/records/batch") public List<RecordResponse> createRecords(@Valid @RequestBody BatchRecordRequest request,Authentication auth){if(!isAdmin(auth))request=new BatchRecordRequest(employeeProfileId,request.items());return service.addRecords(request);}
 @PutMapping("/records/{id}") public RecordResponse updateRecord(@PathVariable Long id,@Valid @RequestBody RecordRequest request,Authentication auth){boolean admin=isAdmin(auth);if(!admin)request=new RecordRequest(employeeProfileId,request.snackId(),request.quantity());return service.updateRecord(id,request,admin?null:employeeProfileId);}
 @DeleteMapping("/records/{id}") @ResponseStatus(org.springframework.http.HttpStatus.NO_CONTENT) public void deleteRecord(@PathVariable Long id,Authentication auth){service.deleteRecord(id,isAdmin(auth)?null:employeeProfileId);}
 @GetMapping("/records") public List<RecordResponse> records(@RequestParam(required=false) @DateTimeFormat(iso=DateTimeFormat.ISO.DATE) LocalDate date,@RequestParam(required=false) @DateTimeFormat(iso=DateTimeFormat.ISO.DATE) LocalDate from,@RequestParam(required=false) @DateTimeFormat(iso=DateTimeFormat.ISO.DATE) LocalDate to,@RequestParam(required=false) Long employeeId,@RequestParam(required=false) Long snackId,Authentication auth){if(auth.getAuthorities().stream().noneMatch(a->a.getAuthority().equals("ROLE_ADMIN")))employeeId=employeeProfileId;return service.history(date,from,to,employeeId,snackId);}
 @GetMapping("/records/{id}") public RecordResponse record(@PathVariable Long id,Authentication auth){return service.getRecord(id,auth.getAuthorities().stream().anyMatch(a->a.getAuthority().equals("ROLE_ADMIN"))?null:employeeProfileId);}
 @GetMapping("/dashboard/summary") public DashboardResponse summary(@RequestParam(required=false) @DateTimeFormat(iso=DateTimeFormat.ISO.DATE) LocalDate date){return service.dashboard(date);}
 @GetMapping("/dashboard/employee-summary") public List<TotalRow> employeeSummary(@RequestParam(required=false) @DateTimeFormat(iso=DateTimeFormat.ISO.DATE) LocalDate date){LocalDate d=date==null?LocalDate.now(java.time.ZoneId.of("Asia/Kolkata")):date;return service.employeeTotals(d,d);}
 @GetMapping("/dashboard/snack-summary") public List<TotalRow> snackSummary(@RequestParam(required=false) @DateTimeFormat(iso=DateTimeFormat.ISO.DATE) LocalDate date){LocalDate d=date==null?LocalDate.now(java.time.ZoneId.of("Asia/Kolkata")):date;return service.snackTotals(d,d);}
 @GetMapping("/reports/daily") public Map<String,Object> daily(@RequestParam @DateTimeFormat(iso=DateTimeFormat.ISO.DATE) LocalDate date){return report(date,date);}
 @GetMapping("/reports/weekly") public Map<String,Object> weekly(@RequestParam @DateTimeFormat(iso=DateTimeFormat.ISO.DATE) LocalDate from,@RequestParam @DateTimeFormat(iso=DateTimeFormat.ISO.DATE) LocalDate to){return report(from,to);}
 @GetMapping("/reports/monthly") public Map<String,Object> monthly(@RequestParam int year,@RequestParam int month){LocalDate from=LocalDate.of(year,month,1);return report(from,from.withDayOfMonth(from.lengthOfMonth()));}
 private Map<String,Object> report(LocalDate from,LocalDate to){List<TotalRow> e=service.employeeTotals(from,to),s=service.snackTotals(from,to);long totalRecords=s.stream().mapToLong(TotalRow::records).sum(),totalQuantity=s.stream().mapToLong(TotalRow::quantity).sum();return Map.of("from",from,"to",to,"totalRecords",totalRecords,"totalQuantity",totalQuantity,"employees",e,"snacks",s);}
 private boolean isAdmin(Authentication auth){return auth.getAuthorities().stream().anyMatch(a->a.getAuthority().equals("ROLE_ADMIN"));}
}
